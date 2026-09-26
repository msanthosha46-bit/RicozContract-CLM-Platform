// Regression tests for the Nodemailer password reset mailer. The SMTP transport
// options and the message body are asserted directly, and the message is then
// rendered by a real Nodemailer stream transport so the library's own address
// parsing and header generation are exercised. Nothing is sent over the
// network and no credential value is ever logged.
const assert = require('node:assert/strict');
const test = require('node:test');
const nodemailer = require('nodemailer');

const mailer = require('../utils/mailer');

const SMTP_VARS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'EMAIL_FROM'
];

// Runs fn with the given SMTP environment, restoring the previous values after.
const withSmtpEnv = (env, fn) => {
  const saved = {};
  for (const name of SMTP_VARS) {
    saved[name] = process.env[name];
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  const restore = () => {
    for (const name of SMTP_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          restore();
          return value;
        },
        (error) => {
          restore();
          throw error;
        }
      );
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
};

// A real Nodemailer transport that renders the message to a buffer instead of
// delivering it, so the library's real parsing/encoding path is used.
const renderMessage = async (message) => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail(message);
  return info.message.toString('utf8');
};

const baseArgs = {
  to: 'employee@ricozcontract.local',
  resetLink: 'https://app.ricozcontract.local/reset-password?token=abc123',
  expiresInMinutes: 15
};

test('the installed nodemailer is a version without the reported advisories', () => {
  const major = Number(require('nodemailer/package.json').version.split('.')[0]);
  assert.ok(major >= 9, `expected nodemailer 9.x or newer, got ${major}`);
});

test('transport options default to STARTTLS on port 587 with no auth', () => {
  const options = withSmtpEnv({ SMTP_HOST: 'smtp.example.com' }, () => mailer.buildTransportOptions());
  assert.equal(options.host, 'smtp.example.com');
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.auth, undefined);
  assert.equal(options.connectionTimeout, 10000);
  assert.equal(options.greetingTimeout, 10000);
  assert.equal(options.socketTimeout, 20000);
});

test('transport options carry explicit port, secure flag and credentials', () => {
  const options = withSmtpEnv(
    {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'mailer@ricozcontract.local',
      SMTP_PASSWORD: 'smtp-secret'
    },
    () => mailer.buildTransportOptions()
  );
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.deepEqual(options.auth, { user: 'mailer@ricozcontract.local', pass: 'smtp-secret' });
});

test('SMTP_SECURE is only enabled for the exact string true', () => {
  for (const value of ['false', '1', 'TRUE', 'yes', '']) {
    const options = withSmtpEnv({ SMTP_HOST: 'smtp.example.com', SMTP_SECURE: value }, () =>
      mailer.buildTransportOptions()
    );
    assert.equal(options.secure, false, `SMTP_SECURE=${value} must not enable secure`);
  }
});

test('the sender falls back from EMAIL_FROM to SMTP_USER to a local address', () => {
  const explicit = withSmtpEnv(
    { SMTP_HOST: 'h', EMAIL_FROM: 'no-reply@ricozcontract.local', SMTP_USER: 'smtp@ricozcontract.local' },
    () => mailer.buildPasswordResetMessage(baseArgs)
  );
  assert.equal(explicit.from, 'no-reply@ricozcontract.local');

  const fromUser = withSmtpEnv(
    { SMTP_HOST: 'h', SMTP_USER: 'smtp@ricozcontract.local' },
    () => mailer.buildPasswordResetMessage(baseArgs)
  );
  assert.equal(fromUser.from, 'smtp@ricozcontract.local');

  const fallback = withSmtpEnv({ SMTP_HOST: 'h' }, () => mailer.buildPasswordResetMessage(baseArgs));
  assert.equal(fallback.from, 'no-reply@ricozcontract.local');
});

test('the reset message carries the subject, the link and the expiry', () => {
  const message = withSmtpEnv({ SMTP_HOST: 'h' }, () => mailer.buildPasswordResetMessage(baseArgs));
  assert.equal(message.subject, 'Reset your RicozContract password');
  assert.ok(message.text.includes(baseArgs.resetLink));
  assert.ok(message.text.includes('15 minutes'));
  assert.ok(message.html.includes(baseArgs.resetLink));
  assert.ok(message.html.includes('15 minutes'));
  assert.ok(message.text.includes('ignore this email'));
});

test('a non numeric expiry falls back to 15 minutes', () => {
  for (const value of [undefined, null, 'soon', NaN, {}]) {
    const message = withSmtpEnv({ SMTP_HOST: 'h' }, () =>
      mailer.buildPasswordResetMessage({ ...baseArgs, expiresInMinutes: value })
    );
    assert.ok(message.text.includes('15 minutes'), `expiry ${String(value)} must default to 15`);
  }
});

test('nodemailer renders the reset message with a correct To and Subject header', async () => {
  const message = withSmtpEnv({ SMTP_HOST: 'h', EMAIL_FROM: 'no-reply@ricozcontract.local' }, () =>
    mailer.buildPasswordResetMessage(baseArgs)
  );
  const raw = await renderMessage(message);
  assert.match(raw, /^To: employee@ricozcontract\.local/m);
  assert.match(raw, /^From: no-reply@ricozcontract\.local/m);
  assert.match(raw, /^Subject: Reset your RicozContract password/m);
  assert.ok(raw.includes(baseArgs.resetLink), 'the reset link must survive MIME encoding');
  assert.match(raw, /^MIME-Version: 1\.0/m);
});

test('a CRLF payload in the recipient cannot inject an extra header', async () => {
  // The API already rejects this shape, so this is defence in depth: the
  // upgraded library must not let a crafted address forge a header either.
  const message = withSmtpEnv({ SMTP_HOST: 'h' }, () =>
    mailer.buildPasswordResetMessage({
      ...baseArgs,
      to: 'attacker@evil.example\r\nBcc: victim@ricozcontract.local'
    })
  );

  let raw = null;
  try {
    raw = await renderMessage(message);
  } catch (error) {
    // Refusing the malformed address outright is also an acceptable outcome.
    assert.ok(error instanceof Error, 'a refusal must be an Error');
    return;
  }

  const headerBlock = raw.split(/\r?\n\r?\n/)[0];
  assert.ok(
    !/^Bcc:/mi.test(headerBlock),
    `recipient CRLF injection reached the headers:\n${headerBlock}`
  );
});

test('a deeply nested group address is parsed without a stack overflow', async () => {
  const nested = `${'('.repeat(600)}victim@ricozcontract.local${')'.repeat(600)}`;
  const message = withSmtpEnv({ SMTP_HOST: 'h' }, () =>
    mailer.buildPasswordResetMessage({ ...baseArgs, to: nested })
  );

  // A RangeError here is the pre-upgrade denial of service.
  await renderMessage(message).catch((error) => {
    assert.ok(
      !(error instanceof RangeError),
      `address parser overflowed: ${error.constructor.name}`
    );
  });
});

test('a large recipient list is parsed in linear time', async () => {
  const many = Array.from({ length: 4000 }, (_, i) => `user${i}@ricozcontract.local`).join(', ');
  const message = withSmtpEnv({ SMTP_HOST: 'h' }, () => mailer.buildPasswordResetMessage({ ...baseArgs, to: many }));

  const started = process.hrtime.bigint();
  await renderMessage(message);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // Quadratic parsing made this take minutes; a generous bound still catches it.
  assert.ok(elapsedMs < 5000, `parsing 4000 recipients took ${elapsedMs.toFixed(0)}ms`);
});

test('sending fails with a clear code when SMTP is not configured', async () => {
  await withSmtpEnv({ SMTP_HOST: undefined }, async () => {
    assert.equal(mailer.isSmtpConfigured(), false);
    await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
      assert.equal(error.code, 'SMTP_NOT_CONFIGURED');
      assert.match(error.message, /SMTP_HOST/);
      return true;
    });
  });
});

test('sending hands the built message to nodemailer', async () => {
  const original = nodemailer.createTransport;
  const seen = [];
  const delivered = [];
  nodemailer.createTransport = (options) => {
    seen.push(options);
    return {
      sendMail: async (message) => {
        delivered.push(message);
        return { accepted: [message.to], messageId: 'test' };
      }
    };
  };

  try {
    await withSmtpEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '2525' }, async () => {
      await mailer.sendPasswordResetEmail(baseArgs);
    });
  } finally {
    nodemailer.createTransport = original;
  }

  assert.equal(seen.length, 1, 'exactly one transport is created per send');
  assert.equal(seen[0].host, 'smtp.example.com');
  assert.equal(seen[0].port, 2525);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].to, baseArgs.to);
  assert.equal(delivered[0].subject, 'Reset your RicozContract password');
  assert.ok(delivered[0].text.includes(baseArgs.resetLink));
});

test('an SMTP delivery failure propagates so the route can log it safely', async () => {
  const original = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      const error = new Error('550 mailbox unavailable');
      error.code = 'EENVELOPE';
      throw error;
    }
  });

  try {
    await withSmtpEnv({ SMTP_HOST: 'smtp.example.com' }, async () => {
      await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
        assert.equal(error.code, 'EENVELOPE');
        // The message must not contain the reset link, so logging it is safe.
        assert.ok(!error.message.includes(baseArgs.resetLink));
        return true;
      });
    });
  } finally {
    nodemailer.createTransport = original;
  }
});
