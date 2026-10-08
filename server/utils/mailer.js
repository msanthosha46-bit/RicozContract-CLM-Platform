const https = require('https');
const nodemailer = require('nodemailer');

// Password-reset email delivery.
//
// Two transports are supported. Resend is an HTTPS API call, so it is not
// affected by the platform host blocking or throttling outbound SMTP (the cause
// of the "Connection timeout" reports), and it is therefore used whenever its
// key is present. SMTP via Nodemailer is kept as an optional fallback and is
// used on its own when no Resend key is configured.
//
// Every credential comes from the environment and nothing sensitive is logged
// here. sanitizeForLog is the only function allowed to build a log string: API
// keys, SMTP passwords, reset links, reset tokens and recipient addresses are
// removed before the text reaches a log line.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = Number(process.env.RESEND_TIMEOUT_MS) || 10000;
// Error bodies are only used to explain a rejection, so a small cap is enough.
const MAX_ERROR_BODY_BYTES = 8 * 1024;

const DEFAULT_FROM = 'no-reply@ricozcontract.local';
const EMAIL_ADDRESS_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const ANGLE_ADDRESS_PATTERN = /<([^<>]+)>/;

// ------------------------------------------------------------------ config ---

const isResendConfigured = () =>
  typeof process.env.RESEND_API_KEY === 'string' && Boolean(process.env.RESEND_API_KEY.trim());

const isSmtpConfigured = () =>
  typeof process.env.SMTP_HOST === 'string' && Boolean(process.env.SMTP_HOST.trim());

// The transport a single send will use first. Resend wins whenever its key is
// set, because the HTTPS API path is the one that works on a restricted host.
const getEmailProvider = () => {
  if (isResendConfigured()) return 'resend';
  if (isSmtpConfigured()) return 'smtp';
  return null;
};

// The ordered transports a send will actually try, best first.
const resolveProviderChain = () => {
  const chain = [];
  if (isResendConfigured()) chain.push('resend');
  if (isSmtpConfigured()) chain.push('smtp');
  return chain;
};

// EMAIL_FROM is allowed to be a display-name form, e.g. "RicozContract <a@b.com>".
const extractAddress = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(ANGLE_ADDRESS_PATTERN);
  return (match ? match[1] : raw).trim();
};

// An invalid port is reported by validateEmailConfig, but must never reach
// Nodemailer as NaN, so an unusable value falls back to the STARTTLS default.
const resolveSmtpPort = () => {
  const raw = String(process.env.SMTP_PORT || '').trim();
  if (!raw) return 587;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 587;
  return port;
};

// Exported separately from getTransport so the SMTP wiring can be unit tested
// without opening a network connection.
const buildTransportOptions = () => ({
  host: process.env.SMTP_HOST,
  port: resolveSmtpPort(),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    : undefined,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000
});

const getTransport = () => nodemailer.createTransport(buildTransportOptions());

// Reports every configuration defect before a request is made, so a missing
// variable is found on the platform dashboard rather than in a user complaint.
// problems block delivery, warnings are worth fixing but still deliver.
const validateEmailConfig = () => {
  const problems = [];
  const warnings = [];
  const chain = resolveProviderChain();
  const smtpIsPrimary = chain[0] === 'smtp';

  if (!chain.length) {
    problems.push('No email transport is configured. Set RESEND_API_KEY (preferred) or SMTP_HOST.');
  }

  if (isResendConfigured()) {
    const apiKey = process.env.RESEND_API_KEY.trim();
    if (!/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey)) {
      warnings.push('RESEND_API_KEY does not look like a Resend API key (expected the re_ prefix).');
    }
    if (!process.env.EMAIL_FROM || !process.env.EMAIL_FROM.trim()) {
      problems.push('EMAIL_FROM is required when RESEND_API_KEY is set: Resend only sends from a verified address.');
    } else if (!EMAIL_ADDRESS_PATTERN.test(extractAddress(process.env.EMAIL_FROM))) {
      problems.push('EMAIL_FROM is not a usable email address.');
    }
  }

  if (isSmtpConfigured()) {
    const rawPort = String(process.env.SMTP_PORT || '').trim();
    const port = Number(rawPort);
    if (rawPort && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      // Silently defaulting to 587 hides the typo, so it is a blocker whenever
      // SMTP is the only transport and a warning when Resend carries the load.
      const detail = `SMTP_PORT="${rawPort}" is not a port number; 587 is being used instead.`;
      (smtpIsPrimary ? problems : warnings).push(detail);
    }
    if (process.env.SMTP_USER && !process.env.SMTP_PASSWORD) {
      warnings.push('SMTP_USER is set but SMTP_PASSWORD is empty; authentication will be rejected.');
    }
    if (!process.env.EMAIL_FROM || !process.env.EMAIL_FROM.trim()) {
      const detail = 'EMAIL_FROM is not set; the sender address falls back to SMTP_USER.';
      (smtpIsPrimary ? problems : warnings).push(detail);
    }
  }

  if (chain.length > 1) {
    warnings.push('Resend and SMTP are both configured; SMTP stays as a fallback for a failed Resend send.');
  }

  return { provider: getEmailProvider(), transports: chain, valid: problems.length === 0, problems, warnings };
};

// ---------------------------------------------------------------- logging ---

// Values that must never appear in a log line, taken from the live environment
// so a newly added secret is covered without editing this list.
const configuredSecrets = () =>
  [process.env.RESEND_API_KEY, process.env.SMTP_PASSWORD].filter(
    (value) => typeof value === 'string' && value.trim().length >= 6
  );

// Reduces an arbitrary value to a single short line with every credential, reset
// link, reset token and email address removed. This is the only sanctioned way
// to turn an error into log output.
const sanitizeForLog = (value) => {
  if (value === undefined || value === null) return '';
  let text = String(value);
  for (const secret of configuredSecrets()) {
    text = text.split(secret).join('[redacted-secret]');
  }
  text = text
    .replace(/\b(re_[A-Za-z0-9_-]{6,})\b/g, '[redacted-api-key]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\/\/(?:[\w.-]+@)/g, '//[redacted]')
    .replace(/([\w.+-]+)@([\w-]+\.[\w.-]+)/g, '[redacted-email]')
    .replace(
      // "authorization" and "bearer" are handled above, so they are left out
      // here to avoid double redacting the word that carries the value.
      /\b((?:api[-_ ]?key|token|password|passwd|secret|credential)s?\s*[:=]\s*)(\S+)/gi,
      '$1[redacted]'
    )
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 200) text = `${text.slice(0, 197)}...`;
  return text;
};

// The single line a caller should log for a failed send: which transports were
// tried, each one's status and reason, with no token, link, key or address.
const describeEmailError = (error) => {
  if (!error) return 'unknown error';
  const summary = [`code=${error.code || 'UNKNOWN'}`];
  if (error.statusCode) summary.push(`http=${error.statusCode}`);
  if (error.resendCode) summary.push(`resend_code=${sanitizeForLog(error.resendCode)}`);
  if (Array.isArray(error.attempts) && error.attempts.length) {
    summary.push(
      `tried=${error.attempts
        .map((attempt) => {
          const status = attempt.status ? ` HTTP ${attempt.status}` : '';
          return `${attempt.provider}(${attempt.code}${status}): ${sanitizeForLog(attempt.reason) || 'no reason given'}`;
        })
        .join(' | ')}`
    );
  } else if (error.message) {
    summary.push(`reason=${sanitizeForLog(error.message)}`);
  }
  return summary.join(' ');
};

// ---------------------------------------------------------------- message ---

// Pure message builder: takes the recipient and reset link and returns the
// nodemailer message object. Kept side-effect free so the rendered MIME can be
// asserted in tests without sending mail.
const buildPasswordResetMessage = ({ to, resetLink, expiresInMinutes }) => {
  const minutes = Number.isFinite(expiresInMinutes) ? expiresInMinutes : 15;
  return {
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || DEFAULT_FROM,
    to,
    subject: 'Reset your RicozContract password',
    text: [
      'We received a request to reset your RicozContract password.',
      '',
      `Reset link: ${resetLink}`,
      '',
      `This link expires in ${minutes} minutes and can only be used once.`,
      'If you did not request this, you can safely ignore this email.'
    ].join('\n'),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; color: #0f172a;">
        <h2 style="margin-bottom: 8px;">Reset your password</h2>
        <p>We received a request to reset your RicozContract password.</p>
        <p>
          <a href="${resetLink}"
             style="display: inline-block; background: #d51d29; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: bold;">
            Reset password
          </a>
        </p>
        <p style="color: #475569; font-size: 13px;">
          This link expires in ${minutes} minutes and can only be used once.<br/>
          If the button does not work, copy this link into your browser:<br/>
          <span style="word-break: break-all;">${resetLink}</span>
        </p>
        <p style="color: #64748b; font-size: 13px;">If you did not request this, you can safely ignore this email.</p>
      </div>`
  };
};

// Resend takes `to` as a list of recipients and the same field names as the
// message object, so the body is a direct mapping of the built message.
const buildResendPayload = (message) => ({
  from: message.from,
  to: Array.isArray(message.to) ? message.to : [message.to],
  subject: message.subject,
  text: message.text,
  html: message.html
});

const configError = (code, message, provider) => {
  const error = new Error(message);
  error.code = code;
  error.provider = provider;
  return error;
};

// ----------------------------------------------------------------- resend ---

// Single HTTPS request to the Resend API. Resolves to a small result object on
// 2xx and rejects with a code, an HTTP status and a sanitized detail otherwise.
const sendViaResend = (message) =>
  new Promise((resolve, reject) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      reject(configError('RESEND_NOT_CONFIGURED', 'RESEND_API_KEY is missing', 'resend'));
      return;
    }
    if (!process.env.EMAIL_FROM || !process.env.EMAIL_FROM.trim()) {
      // Checked before the request: Resend would reject it anyway, and a wasted
      // round trip would delay the SMTP fallback.
      reject(configError('EMAIL_FROM_NOT_CONFIGURED', 'EMAIL_FROM is required by the Resend transport', 'resend'));
      return;
    }

    const body = JSON.stringify(buildResendPayload(message));
    const url = new URL(RESEND_ENDPOINT);
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };

    const request = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          authorization: `Bearer ${apiKey.trim()}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'ricozcontract-api'
        }
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          if (received >= MAX_ERROR_BODY_BYTES) return;
          chunks.push(chunk);
          received += chunk.length;
        });
        response.on('error', (error) => {
          const failure = new Error(`Resend response failed: ${error.message}`);
          failure.code = 'RESEND_RESPONSE_ERROR';
          failure.provider = 'resend';
          settle(reject, failure);
        });
        response.on('aborted', () => {
          const failure = new Error('Resend closed the connection before the response completed');
          failure.code = 'RESEND_RESPONSE_ABORTED';
          failure.provider = 'resend';
          settle(reject, failure);
        });
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (statusCode >= 200 && statusCode < 300) {
            let messageId = null;
            try {
              messageId = JSON.parse(raw).id || null;
            } catch (error) {
              messageId = null;
            }
            settle(resolve, { provider: 'resend', messageId, statusCode });
            return;
          }

          // Resend reports failures as { name, message, statusCode }. The body
          // can quote the recipient, so it is sanitized before it is kept.
          let detail = raw;
          let resendCode = null;
          try {
            const parsed = JSON.parse(raw);
            detail = parsed.message || parsed.error || raw;
            resendCode = parsed.name || parsed.code || null;
          } catch (error) {
            resendCode = null;
          }

          const failure = new Error(`Resend rejected the password reset email (HTTP ${statusCode})`);
          failure.code = 'RESEND_HTTP_ERROR';
          failure.provider = 'resend';
          failure.statusCode = statusCode;
          failure.resendCode = resendCode;
          failure.detail = sanitizeForLog(detail) || 'no reason given';
          settle(reject, failure);
        });
      }
    );

    request.on('error', (error) => {
      const failure = new Error(`Resend request failed: ${error.message}`);
      failure.code = 'RESEND_REQUEST_FAILED';
      failure.provider = 'resend';
      settle(reject, failure);
    });

    request.setTimeout(RESEND_TIMEOUT_MS, () => {
      const failure = new Error(`Resend request timed out after ${RESEND_TIMEOUT_MS}ms`);
      failure.code = 'RESEND_TIMEOUT';
      failure.provider = 'resend';
      request.destroy(failure);
      settle(reject, failure);
    });

    request.write(body);
    request.end();
  });

// ------------------------------------------------------------------ smtp ---

const sendViaSmtp = async (message) => {
  if (!isSmtpConfigured()) {
    throw configError('SMTP_NOT_CONFIGURED', 'SMTP is not configured (SMTP_HOST is missing)', 'smtp');
  }
  const info = await getTransport().sendMail(message);
  return {
    provider: 'smtp',
    messageId: (info && info.messageId) || null,
    accepted: (info && info.accepted) || []
  };
};

// ------------------------------------------------------------------ send ---

// Tries each configured transport in order. The caller's reset token is not
// touched by this function: when every transport fails the stored token stays
// exactly as valid as it was, so a later retry or a working transport can still
// use it.
const sendPasswordResetEmail = async (args) => {
  const chain = resolveProviderChain();
  if (!chain.length) {
    // The legacy code is kept so existing log alerts keep matching.
    const error = new Error(
      'No email transport is configured. Set RESEND_API_KEY (preferred) or SMTP_HOST for password reset email.'
    );
    error.code = 'SMTP_NOT_CONFIGURED';
    error.provider = null;
    throw error;
  }

  const message = buildPasswordResetMessage(args);
  const failures = [];

  for (const provider of chain) {
    try {
      return await (provider === 'resend' ? sendViaResend(message) : sendViaSmtp(message));
    } catch (error) {
      failures.push({ provider, error });
    }
  }

  // A single configured transport keeps its original error so existing handling
  // and alerts (SMTP codes, for example) are unaffected.
  if (failures.length === 1) throw failures[0].error;

  const error = new Error('Every configured email transport failed to send the password reset email');
  error.code = 'EMAIL_SEND_FAILED';
  error.attempts = failures.map(({ provider, error: cause }) => ({
    provider,
    code: cause.code || 'UNKNOWN',
    status: cause.statusCode || null,
    reason: sanitizeForLog(cause.detail || cause.message)
  }));
  throw error;
};

// Pure message builder for the Google sign-in one-time code. Kept side-effect
// free (like buildPasswordResetMessage) so the rendered MIME can be asserted in
// tests without sending mail. The code is never logged by anything in this
// module: it only ever reaches the message body and the transport.
const buildOtpMessage = ({ to, otp, expiresInMinutes }) => {
  const minutes = Number.isFinite(expiresInMinutes) ? expiresInMinutes : 5;
  return {
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || DEFAULT_FROM,
    to,
    subject: 'Your RicozContract verification code',
    text: [
      'Your RicozContract sign-in verification code is:',
      '',
      otp,
      '',
      `This code expires in ${minutes} minutes and can only be used once.`,
      'If you did not request this code, you can safely ignore this email.'
    ].join('\n'),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; color: #0f172a;">
        <h2 style="margin-bottom: 8px;">Your verification code</h2>
        <p>Use the code below to finish signing in to RicozContract.</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 16px 0;">${otp}</p>
        <p style="color: #475569; font-size: 13px;">
          This code expires in ${minutes} minutes and can only be used once.<br/>
          If you did not request this code, you can safely ignore this email.
        </p>
      </div>`
  };
};

// Tries each configured transport in order (Resend first, SMTP as the fallback)
// exactly like sendPasswordResetEmail. The caller's code is not touched by this
// function: when every transport fails the stored OTP hash stays exactly as
// valid as it was, so a resend or a retry can still use it.
const sendOtpEmail = async (args) => {
  const chain = resolveProviderChain();
  if (!chain.length) {
    const error = new Error(
      'No email transport is configured. Set RESEND_API_KEY (preferred) or SMTP_HOST for verification code email.'
    );
    error.code = 'SMTP_NOT_CONFIGURED';
    error.provider = null;
    throw error;
  }

  const message = buildOtpMessage(args);
  const failures = [];

  for (const provider of chain) {
    try {
      return await (provider === 'resend' ? sendViaResend(message) : sendViaSmtp(message));
    } catch (error) {
      failures.push({ provider, error });
    }
  }

  if (failures.length === 1) throw failures[0].error;

  const error = new Error('Every configured email transport failed to send the verification code email');
  error.code = 'EMAIL_SEND_FAILED';
  error.attempts = failures.map(({ provider, error: cause }) => ({
    provider,
    code: cause.code || 'UNKNOWN',
    status: cause.statusCode || null,
    reason: sanitizeForLog(cause.detail || cause.message)
  }));
  throw error;
};

module.exports = {
  isSmtpConfigured,
  isResendConfigured,
  getEmailProvider,
  resolveProviderChain,
  validateEmailConfig,
  extractAddress,
  buildTransportOptions,
  buildPasswordResetMessage,
  buildOtpMessage,
  buildResendPayload,
  sanitizeForLog,
  describeEmailError,
  sendPasswordResetEmail,
  sendOtpEmail
};
