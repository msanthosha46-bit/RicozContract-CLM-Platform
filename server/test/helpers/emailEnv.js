// Shared email-environment helper for the mailer test suites.
//
// Every test that touches the mailer must control the whole email environment,
// otherwise a RESEND_API_KEY present in a developer's shell or .env file would
// silently change which transport runs. The helper lists all of them so a test
// always starts from a known, empty state.
//
// CLIENT_URL is included because it is the base of the reset link that the
// mailer puts in the message, so a test asserting on that link needs it pinned.

const EMAIL_VARS = [
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'CLIENT_URL'
];

// Runs fn with the given email environment, restoring the previous values after.
// A key that is absent from `env` is deleted, so every unspecified variable is
// guaranteed to be unset while fn runs.
const withEmailEnv = (env, fn) => {
  const saved = {};
  for (const name of EMAIL_VARS) {
    saved[name] = process.env[name];
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  const restore = () => {
    for (const name of EMAIL_VARS) {
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

module.exports = { EMAIL_VARS, withEmailEnv };
