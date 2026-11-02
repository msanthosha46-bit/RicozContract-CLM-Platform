const assert = require('node:assert/strict');
const test = require('node:test');

const mailer = require('../utils/mailer');
const { withEmailEnv } = require('./helpers/emailEnv');
const { stubHttps, stubSmtp } = require('./helpers/emailTransports');

const ZEPTOMAIL_PASSWORD = 'zeptomail-test-password';
const ZEPTOMAIL_USER = 'zeptomail-test-user';
const RECIPIENT = 'employee@ricozcontract.local';
const RESET_LINK = 'https://app.ricozcontract.local/reset-password?token=abc123';

const zeptoMailEnv = (extra = {}) => ({
  ZEPTOMAIL_SMTP_HOST: 'smtp.zeptomail.in',
  ZEPTOMAIL_SMTP_USER: ZEPTOMAIL_USER,
  ZEPTOMAIL_SMTP_PASSWORD: ZEPTOMAIL_PASSWORD,
  ZEPTOMAIL_FROM_EMAIL: 'no-reply@ricozcontract.local',
  ZEPTOMAIL_FROM_NAME: 'RicozContract',
  ...extra
});

test('ZeptoMail is primary and transports are ordered before both fallbacks', () => {
  const config = withEmailEnv(
    zeptoMailEnv({
      RESEND_API_KEY: 're_testkey0123456789',
      EMAIL_FROM: 'fallback@ricozcontract.local',
      SMTP_HOST: 'smtp.example.com'
    }),
    () => mailer.validateEmailConfig()
  );

  assert.equal(config.provider, 'zeptomail');
  assert.deepEqual(config.transports, ['zeptomail', 'resend', 'smtp']);
  assert.equal(config.valid, true, config.problems.join('; '));
});

test('ZeptoMail defaults to smtp.zeptomail.in on STARTTLS port 587', () => {
  const options = withEmailEnv(
    zeptoMailEnv({ ZEPTOMAIL_SMTP_HOST: undefined }),
    () => mailer.buildZeptoMailTransportOptions()
  );

  assert.equal(options.host, 'smtp.zeptomail.in');
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.deepEqual(options.auth, { user: ZEPTOMAIL_USER, pass: ZEPTOMAIL_PASSWORD });
});

test('ZeptoMail port 465 uses implicit TLS', () => {
  const options = withEmailEnv(
    zeptoMailEnv({ ZEPTOMAIL_SMTP_PORT: '465' }),
    () => mailer.buildZeptoMailTransportOptions()
  );

  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.requireTLS, undefined);
});

test('ZeptoMail sender includes the configured display name and verified address', () => {
  const from = withEmailEnv(zeptoMailEnv(), () => mailer.buildZeptoMailFrom());
  assert.equal(from, '"RicozContract" <no-reply@ricozcontract.local>');
});

test('password-reset and Google OTP messages use ZeptoMail', async () => {
  const smtpStub = stubSmtp();
  try {
    const results = await withEmailEnv(zeptoMailEnv(), async () => ({
      reset: await mailer.sendPasswordResetEmail({
        to: RECIPIENT,
        resetLink: RESET_LINK,
        expiresInMinutes: 15
      }),
      otp: await mailer.sendOtpEmail({
        to: RECIPIENT,
        otp: '123456',
        expiresInMinutes: 5
      })
    }));

    assert.equal(results.reset.provider, 'zeptomail');
    assert.equal(results.otp.provider, 'zeptomail');
    assert.equal(smtpStub.delivered.length, 2);
    assert.equal(smtpStub.delivered[0].from, '"RicozContract" <no-reply@ricozcontract.local>');
    assert.ok(smtpStub.delivered[0].text.includes(RESET_LINK));
    assert.equal(smtpStub.delivered[1].subject, 'Your RicozContract verification code');
    assert.ok(smtpStub.delivered[1].text.includes('123456'));
  } finally {
    smtpStub.restore();
  }
});

test('a ZeptoMail failure falls back to Resend', async () => {
  const smtpStub = stubSmtp(async () => {
    const error = new Error('ZeptoMail unavailable');
    error.code = 'ECONNECTION';
    throw error;
  });
  const httpsStub = stubHttps(({ respond }) => respond({ status: 200, body: '{"id":"resend-id"}' }));

  try {
    const result = await withEmailEnv(
      zeptoMailEnv({
        RESEND_API_KEY: 're_testkey0123456789',
        EMAIL_FROM: 'fallback@ricozcontract.local'
      }),
      () => mailer.sendPasswordResetEmail({ to: RECIPIENT, resetLink: RESET_LINK })
    );

    assert.equal(result.provider, 'resend');
    assert.equal(smtpStub.delivered.length, 1);
    assert.equal(httpsStub.calls.length, 1);
  } finally {
    smtpStub.restore();
    httpsStub.restore();
  }
});

test('failed ZeptoMail and Resend attempts fall back to generic SMTP', async () => {
  let smtpAttempts = 0;
  const smtpStub = stubSmtp(async () => {
    smtpAttempts += 1;
    if (smtpAttempts === 1) {
      const error = new Error('ZeptoMail unavailable');
      error.code = 'ECONNECTION';
      throw error;
    }
    return { messageId: 'generic-smtp-id', accepted: [RECIPIENT] };
  });
  const httpsStub = stubHttps(({ respond }) =>
    respond({ status: 500, body: '{"message":"Resend unavailable"}' }));

  try {
    const result = await withEmailEnv(
      zeptoMailEnv({
        RESEND_API_KEY: 're_testkey0123456789',
        EMAIL_FROM: 'fallback@ricozcontract.local',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'generic-smtp-user',
        SMTP_PASSWORD: 'generic-smtp-password'
      }),
      () => mailer.sendPasswordResetEmail({ to: RECIPIENT, resetLink: RESET_LINK })
    );

    assert.equal(result.provider, 'smtp');
    assert.equal(smtpAttempts, 2);
    assert.equal(smtpStub.delivered[0].from, '"RicozContract" <no-reply@ricozcontract.local>');
    assert.equal(smtpStub.delivered[1].from, 'fallback@ricozcontract.local');
  } finally {
    smtpStub.restore();
    httpsStub.restore();
  }
});

test('missing ZeptoMail credentials fail safely without passing auth to Nodemailer', async () => {
  const smtpStub = stubSmtp();
  try {
    await withEmailEnv(
      { ZEPTOMAIL_SMTP_HOST: 'smtp.zeptomail.in' },
      async () => {
        const config = mailer.validateEmailConfig();
        assert.equal(config.valid, false);
        assert.ok(config.problems.some((problem) => /ZEPTOMAIL_SMTP_USER/.test(problem)));
        assert.ok(config.problems.some((problem) => /ZEPTOMAIL_SMTP_PASSWORD/.test(problem)));
        await assert.rejects(
          () => mailer.sendPasswordResetEmail({ to: RECIPIENT, resetLink: RESET_LINK }),
          (error) => {
            assert.equal(error.code, 'ZEPTOMAIL_NOT_CONFIGURED');
            assert.ok(!error.message.includes(ZEPTOMAIL_PASSWORD));
            return true;
          }
        );
        assert.equal(smtpStub.delivered.length, 0);
      }
    );
  } finally {
    smtpStub.restore();
  }
});

test('an unsupported ZeptoMail port is reported and never passed through as invalid', () => {
  withEmailEnv(
    zeptoMailEnv({ ZEPTOMAIL_SMTP_PORT: 'not-a-port' }),
    () => {
      const config = mailer.validateEmailConfig();
      assert.equal(config.valid, false);
      assert.ok(config.problems.some((problem) => /ZEPTOMAIL_SMTP_PORT/.test(problem)));
      assert.equal(mailer.buildZeptoMailTransportOptions().port, 587);
    }
  );
});

test('ZeptoMail passwords are redacted from delivery errors', async () => {
  const smtpStub = stubSmtp(async () => {
    const error = new Error(`authentication failed with password ${ZEPTOMAIL_PASSWORD}`);
    error.code = 'EAUTH';
    throw error;
  });
  let logLine = '';
  try {
    await withEmailEnv(zeptoMailEnv(), async () => {
      await assert.rejects(
        () => mailer.sendPasswordResetEmail({ to: RECIPIENT, resetLink: RESET_LINK }),
        (error) => {
          logLine = mailer.describeEmailError(error);
          return true;
        }
      );
    });
  } finally {
    smtpStub.restore();
  }

  assert.ok(!logLine.includes(ZEPTOMAIL_PASSWORD));
  assert.ok(!logLine.includes(ZEPTOMAIL_USER));
});

test('short ZeptoMail passwords are redacted too', () => {
  const output = withEmailEnv(
    zeptoMailEnv({ ZEPTOMAIL_SMTP_PASSWORD: 'x' }),
    () => mailer.sanitizeForLog('x')
  );
  assert.equal(output, '[redacted-secret]');
});
