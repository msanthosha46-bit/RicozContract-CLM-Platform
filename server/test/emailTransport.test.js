// Regression tests for the Resend HTTPS transport added after the password
// reset email failed on Render with "Connection timeout": the platform host
// could not open an outbound SMTP connection, so the mailer now talks to the
// Resend HTTPS API when RESEND_API_KEY is present and keeps SMTP as an optional
// fallback.
//
// No network call and no real API key is used: https.request is replaced with a
// fake that records the request and replays a scripted response, and Nodemailer
// is stubbed at the transport boundary. Every assertion about logs is a
// negative one, because the whole point of the sanitiser is that a key, a reset
// link and a recipient address never reach the log output.
const assert = require('node:assert/strict');
const test = require('node:test');

const mailer = require('../utils/mailer');
const { withEmailEnv } = require('./helpers/emailEnv');
const { stubHttps, stubSmtp } = require('./helpers/emailTransports');

const RESEND_KEY = 're_testonlykey0123456789abcdef';
const RECIPIENT = 'employee@ricozcontract.local';
const RESET_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const RESET_LINK = `https://app.ricozcontract.local/reset-password?token=${RESET_TOKEN}`;

const baseArgs = { to: RECIPIENT, resetLink: RESET_LINK, expiresInMinutes: 15 };

const withResend = (extra, fn) =>
  withEmailEnv({ RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: 'RicozContract <no-reply@ricozcontract.local>', ...extra }, fn);

const accepts = (status = 200, body = '{"id":"resend-message-id"}') => ({ status, body });

// ------------------------------------------------------------- selection ---

test('Resend is the primary transport as soon as its key is configured', () => {
  const resendOnly = withResend({}, () => ({
    config: mailer.validateEmailConfig(),
    configured: mailer.isResendConfigured()
  }));
  assert.equal(resendOnly.configured, true);
  assert.equal(resendOnly.config.provider, 'resend');
  assert.deepEqual(resendOnly.config.transports, ['resend']);
  assert.equal(resendOnly.config.valid, true, `unexpected problems: ${resendOnly.config.problems.join('; ')}`);

  const both = withResend({ SMTP_HOST: 'smtp.example.com' }, () => mailer.validateEmailConfig());
  assert.deepEqual(
    both.transports,
    ['resend', 'smtp'],
    'SMTP must stay available as a fallback, after Resend'
  );
  assert.equal(both.provider, 'resend');
  assert.ok(
    both.warnings.some((warning) => /fallback/i.test(warning)),
    'running both transports should be reported as a warning'
  );
});

test('SMTP stays the transport on its own when no Resend key is configured', () => {
  const smtpOnly = withEmailEnv(
    { SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'no-reply@ricozcontract.local' },
    () => mailer.validateEmailConfig()
  );
  assert.equal(mailer.isResendConfigured(), false);
  assert.equal(smtpOnly.provider, 'smtp');
  assert.deepEqual(smtpOnly.transports, ['smtp']);
  assert.equal(smtpOnly.valid, true, `unexpected problems: ${smtpOnly.problems.join('; ')}`);
});

test('sending with no transport at all fails before any network call', async () => {
  const httpsStub = stubHttps(() => assert.fail('no HTTP request may be made'));
  try {
    await withEmailEnv({}, async () => {
      assert.equal(mailer.getEmailProvider(), null);
      await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
        // Legacy code: existing log alerts keep matching this failure.
        assert.equal(error.code, 'SMTP_NOT_CONFIGURED');
        assert.match(error.message, /SMTP_HOST/);
        assert.match(error.message, /RESEND_API_KEY/, 'the preferred variable must be named');
        return true;
      });
    });
  } finally {
    httpsStub.restore();
  }
  assert.equal(httpsStub.calls.length, 0);
});

// --------------------------------------------------------------- request ---

test('the Resend send is a single authenticated HTTPS POST with the reset message', async () => {
  const httpsStub = stubHttps(({ respond }) => respond(accepts()));
  let result;
  try {
    result = await withResend({}, () => mailer.sendPasswordResetEmail(baseArgs));
  } finally {
    httpsStub.restore();
  }

  assert.equal(httpsStub.calls.length, 1, 'exactly one HTTPS request per send');
  const { options } = httpsStub.calls[0];
  assert.equal(options.hostname, 'api.resend.com');
  assert.equal(options.port, 443);
  assert.equal(options.path, '/emails');
  assert.equal(options.method, 'POST');
  assert.equal(httpsStub.calls[0].headers.authorization, `Bearer ${RESEND_KEY}`);
  assert.equal(httpsStub.calls[0].headers['content-type'], 'application/json');
  assert.equal(
    Number(httpsStub.calls[0].headers['content-length']),
    Buffer.byteLength(httpsStub.calls[0].body),
    'content-length must match the encoded body'
  );

  const { payload } = httpsStub.calls[0];
  assert.deepEqual(payload.to, [RECIPIENT], 'Resend expects a recipient list');
  assert.equal(payload.from, 'RicozContract <no-reply@ricozcontract.local>');
  assert.equal(payload.subject, 'Reset your RicozContract password');
  assert.ok(payload.text.includes(RESET_LINK));
  assert.ok(payload.html.includes(RESET_LINK));
  assert.ok(payload.text.includes('15 minutes'));
  assert.ok(!JSON.stringify(payload).includes('SMTP_PASSWORD'));

  assert.equal(result.provider, 'resend');
  assert.equal(result.messageId, 'resend-message-id');
});

test('the Resend request is abandoned when it hangs instead of blocking the endpoint', async () => {
  // A hang is what produced the reported incident on Render, so the request must
  // give up on its own rather than hold the forgot-password response open.
  const httpsStub = stubHttps(({ call }) => {
    call.hung = true;
  });
  try {
    await withResend({ SMTP_HOST: 'smtp.example.com' }, async () => {
      const smtpStub = stubSmtp();
      try {
        const send = mailer.sendPasswordResetEmail(baseArgs);
        // Give the request a tick to register its timeout, then let it expire.
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(httpsStub.calls[0].timeoutMs > 0, 'the request must set a timeout');
        assert.ok(httpsStub.calls[0].fireTimeout, 'the request must register a timeout handler');
        httpsStub.calls[0].fireTimeout();

        const result = await send;
        // The timeout is a transport failure, so SMTP picks the message up.
        assert.equal(result.provider, 'smtp');
        assert.equal(smtpStub.delivered.length, 1);
      } finally {
        smtpStub.restore();
      }
    });
  } finally {
    httpsStub.restore();
  }
  assert.equal(httpsStub.calls[0].destroyed, true, 'the hung request must be destroyed');
});

// -------------------------------------------------------------- failures ---

test('a missing EMAIL_FROM is caught before the Resend request is made', async () => {
  const httpsStub = stubHttps(() => assert.fail('no HTTP request may be made'));
  try {
    await withEmailEnv({ RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: undefined }, async () => {
      await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
        assert.equal(error.code, 'EMAIL_FROM_NOT_CONFIGURED');
        assert.ok(!error.message.includes(RESEND_KEY));
        return true;
      });
    });
  } finally {
    httpsStub.restore();
  }
  assert.equal(httpsStub.calls.length, 0);
});

test('a rejected Resend API key is reported with its status and never echoed', async () => {
  const httpsStub = stubHttps(({ respond }) =>
    respond(accepts(401, JSON.stringify({ name: 'missing_api_key', message: 'API key is missing' })))
  );
  try {
    await withEmailEnv({ RESEND_API_KEY: 're_wrongkey', EMAIL_FROM: 'no-reply@ricozcontract.local' }, async () => {
      await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
        assert.equal(error.code, 'RESEND_HTTP_ERROR');
        assert.equal(error.statusCode, 401);
        assert.equal(error.resendCode, 'missing_api_key', 'the API error name must survive for triage');
        const described = mailer.describeEmailError(error);
        assert.match(described, /RESEND_HTTP_ERROR/);
        assert.match(described, /http=401/);
        assert.ok(!described.includes('re_wrongkey'), `key leaked into the log line: ${described}`);
        return true;
      });
    });
  } finally {
    httpsStub.restore();
  }
});

test('a Resend rejection body is sanitised before it is kept', async () => {
  const body = JSON.stringify({
    name: 'validation_error',
    message: `The from address ${RECIPIENT} is not verified, token=${RESET_TOKEN} rejected`
  });
  const httpsStub = stubHttps(({ respond }) => respond(accepts(422, body)));
  try {
    await withResend({}, async () => {
      await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
        assert.equal(error.statusCode, 422);
        assert.ok(!error.detail.includes(RECIPIENT), `recipient leaked: ${error.detail}`);
        assert.ok(!error.detail.includes(RESET_TOKEN), `reset token leaked: ${error.detail}`);
        const described = mailer.describeEmailError(error);
        assert.ok(!described.includes(RESET_TOKEN), `reset token leaked: ${described}`);
        return true;
      });
    });
  } finally {
    httpsStub.restore();
  }
});

test('a socket-level failure is reported as a transport error', async () => {
  const httpsStub = stubHttps(({ request }) => {
    const error = new Error('connect ECONNREFUSED 104.18.26.46:443');
    error.code = 'ECONNREFUSED';
    request.emit('error', error);
  });
  try {
    await withResend({}, async () => {
      await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
        assert.equal(error.code, 'RESEND_REQUEST_FAILED');
        const described = mailer.describeEmailError(error);
        assert.match(described, /RESEND_REQUEST_FAILED/);
        assert.ok(!described.includes(RESET_LINK));
        return true;
      });
    });
  } finally {
    httpsStub.restore();
  }
});

test('a response cut off mid-stream is reported, not treated as delivered', async () => {
  const httpsStub = stubHttps(({ respond }) => {
    respond({ status: 200, body: '{"id":', abort: true });
  });
  try {
    await withResend({ SMTP_HOST: 'smtp.example.com' }, async () => {
      const smtpStub = stubSmtp();
      try {
        const result = await mailer.sendPasswordResetEmail(baseArgs);
        assert.equal(result.provider, 'smtp', 'a truncated response must not count as a send');
      } finally {
        smtpStub.restore();
      }
    });
  } finally {
    httpsStub.restore();
  }
});

// --------------------------------------------------------------- fallback ---

test('SMTP delivers the same message when the Resend send fails', async () => {
  const httpsStub = stubHttps(({ respond }) => respond(accepts(500, '{"message":"internal error"}')));
  let result;
  let smtpStub;
  try {
    smtpStub = stubSmtp();
    result = await withResend({ SMTP_HOST: 'smtp.example.com' }, () => mailer.sendPasswordResetEmail(baseArgs));
  } finally {
    httpsStub.restore();
    if (smtpStub) smtpStub.restore();
  }

  assert.equal(result.provider, 'smtp');
  assert.equal(smtpStub.delivered.length, 1, 'the fallback must send exactly once');
  const delivered = smtpStub.delivered[0];
  assert.equal(delivered.to, RECIPIENT);
  assert.equal(delivered.subject, 'Reset your RicozContract password');
  assert.ok(delivered.text.includes(RESET_LINK), 'the fallback must carry the same reset link');
});

test('when every transport fails both attempts are reported and nothing sensitive is', async () => {
  const httpsStub = stubHttps(({ respond }) => respond(accepts(500, '{"message":"internal error"}')));
  let smtpStub;
  try {
    smtpStub = stubSmtp(async () => {
      const error = new Error(`550 5.1.1 ${RECIPIENT}: mailbox unavailable`);
      error.code = 'EENVELOPE';
      throw error;
    });

    await withResend(
      { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'mailer@ricozcontract.local', SMTP_PASSWORD: 'smtp-secret' },
      async () => {
        let failure = null;
        await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
          failure = error;
          assert.equal(error.code, 'EMAIL_SEND_FAILED');
          assert.deepEqual(
            error.attempts.map((attempt) => attempt.provider),
            ['resend', 'smtp'],
            'both attempts must be recorded in order'
          );
          assert.equal(error.attempts[0].status, 500);
          assert.equal(error.attempts[1].code, 'EENVELOPE');
          return true;
        });

        // The route logs describeEmailError and nothing else.
        const described = mailer.describeEmailError(failure);
        assert.match(described, /EMAIL_SEND_FAILED/);
        assert.match(described, /resend\(RESEND_HTTP_ERROR HTTP 500\)/);
        assert.match(described, /smtp\(EENVELOPE\)/);
        for (const secret of [RESET_TOKEN, RESET_LINK, RESEND_KEY, 'smtp-secret', RECIPIENT]) {
          assert.ok(!described.includes(secret), `"${secret}" leaked into the log line: ${described}`);
        }
        assert.ok(described.length <= 700, `the log line must stay short: ${described.length} chars`);
      }
    );
  } finally {
    httpsStub.restore();
    if (smtpStub) smtpStub.restore();
  }
});

test('a lone configured transport still propagates its own error', async () => {
  const smtpStub = stubSmtp(async () => {
    const error = new Error('550 mailbox unavailable');
    error.code = 'EENVELOPE';
    throw error;
  });
  try {
    await withEmailEnv({ SMTP_HOST: 'smtp.example.com' }, async () => {
      await assert.rejects(() => mailer.sendPasswordResetEmail(baseArgs), (error) => {
        assert.equal(error.code, 'EENVELOPE', 'SMTP-only behaviour must be unchanged');
        return true;
      });
    });
  } finally {
    smtpStub.restore();
  }
});

// ------------------------------------------------------------ validation ---

test('validation names the missing Resend variables instead of failing at send time', () => {
  const config = withEmailEnv({ RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: undefined }, () =>
    mailer.validateEmailConfig()
  );
  assert.equal(config.valid, false);
  assert.ok(
    config.problems.some((problem) => /EMAIL_FROM is required/.test(problem)),
    `expected an EMAIL_FROM problem, got: ${config.problems.join('; ')}`
  );

  const unusable = withResend({ EMAIL_FROM: 'not-an-address' }, () => mailer.validateEmailConfig());
  assert.equal(unusable.valid, false);
  assert.ok(unusable.problems.some((problem) => /EMAIL_FROM is not a usable email address/.test(problem)));
});

test('validation reports an unusable SMTP port without ever passing NaN to nodemailer', () => {
  const asPrimary = withEmailEnv(
    { SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'not-a-port', EMAIL_FROM: 'no-reply@ricozcontract.local' },
    () => mailer.validateEmailConfig()
  );
  assert.equal(asPrimary.valid, false, 'SMTP as the only transport must block on a bad port');
  assert.ok(asPrimary.problems.some((problem) => /SMTP_PORT="not-a-port"/.test(problem)));
  assert.equal(mailer.buildTransportOptions().port, 587, 'the wire value falls back to a usable port');

  // With Resend carrying delivery the same typo is only a warning.
  const withResendPrimary = withResend(
    { SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'not-a-port' },
    () => mailer.validateEmailConfig()
  );
  assert.equal(withResendPrimary.valid, true);
  assert.ok(withResendPrimary.warnings.some((warning) => /SMTP_PORT="not-a-port"/.test(warning)));
});

test('validation warns about an API key that is not a sending key', () => {
  const config = withResend({ RESEND_API_KEY: 're_publishable_looking_value' }, () => ({
    config: mailer.validateEmailConfig(),
    provider: mailer.getEmailProvider()
  }));
  // A short suffix is fine, an unprefixed value is what must be reported.
  assert.equal(config.config.valid, true, 'the format check is advisory, delivery still decides');
  assert.equal(config.provider, 'resend');

  const unprefixed = withResend({ RESEND_API_KEY: 'pk_live_1234567890' }, () => mailer.validateEmailConfig());
  assert.ok(
    unprefixed.warnings.some((warning) => /re_ prefix/.test(warning)),
    `expected a prefix warning, got: ${unprefixed.warnings.join('; ')}`
  );
});

// ------------------------------------------------------------- sanitising ---

test('sanitizeForLog removes the live secrets from any value', () => {
  const line = withResend(
    { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'mailer@ricozcontract.local', SMTP_PASSWORD: 'smtp-secret' },
    () =>
      mailer.sanitizeForLog(
        [
          'POST https://api.resend.com/emails',
          `Authorization: Bearer ${RESEND_KEY}`,
          `to=${RECIPIENT}`,
          RESET_LINK,
          'password=smtp-secret',
          `token ${RESET_TOKEN}`,
          'failed\r\nwith a newline'
        ].join(' ')
      )
  );

  for (const secret of [RESEND_KEY, RESET_LINK, RESET_TOKEN, RECIPIENT, 'smtp-secret']) {
    assert.ok(!line.includes(secret), `"${secret}" survived sanitising: ${line}`);
  }
  assert.ok(!line.includes('\n'), 'a sanitised line must be a single line');
  assert.ok(line.length <= 200, `a sanitised line must be short: ${line.length} chars`);
  assert.match(line, /\[redacted-email\]/);
  // Redaction happens before truncation, so a cut-off line is still safe.
  assert.ok(
    line.includes(RESET_LINK.split('?')[0]),
    'the link host is kept for diagnosis while the token is not'
  );
});

test('sanitizeForLog also redacts values that no longer match the live environment', () => {
  // A key echoed back inside an API error body, or a stale secret, is not in
  // process.env any more, so the pattern rules have to catch it on their own.
  const staleKey = 're_leakedFromAnErrorBody_0123456789';
  const line = withResend({}, () =>
    mailer.sanitizeForLog(
      `Authorization: Bearer ${staleKey} for ${RECIPIENT} reset ${RESET_TOKEN} raw ${RESET_LINK}`
    )
  );

  for (const secret of [staleKey, RECIPIENT, RESET_TOKEN, RESET_LINK]) {
    assert.ok(!line.includes(secret), `"${secret}" survived sanitising: ${line}`);
  }
  assert.match(line, /Bearer \[redacted-api-key\]/);
  assert.match(line, /\[redacted-email\]/);
  assert.match(line, /\[redacted-token\]/);
  assert.ok(line.length <= 200, `a sanitised line must be short: ${line.length} chars`);
});

test('describeEmailError produces a single short line for any failure shape', () => {
  assert.equal(mailer.describeEmailError(null), 'unknown error');

  const plain = withResend({}, () =>
    mailer.describeEmailError(Object.assign(new Error('550 mailbox unavailable'), { code: 'EENVELOPE' }))
  );
  assert.equal(plain, 'code=EENVELOPE reason=550 mailbox unavailable');

  const withStatus = withResend({}, () =>
    mailer.describeEmailError(
      Object.assign(new Error('Resend rejected the request'), { code: 'RESEND_HTTP_ERROR', statusCode: 403 })
    )
  );
  assert.equal(withStatus, 'code=RESEND_HTTP_ERROR http=403 reason=Resend rejected the request');
});
