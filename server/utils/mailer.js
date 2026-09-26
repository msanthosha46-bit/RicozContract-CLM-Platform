const nodemailer = require('nodemailer');

// All SMTP credentials come from environment variables. Nothing sensitive
// is logged here, and the reset token/link is never written to any log.

const isSmtpConfigured = () => Boolean(process.env.SMTP_HOST);

// Exported separately from getTransport so the SMTP wiring can be unit tested
// without opening a network connection.
const buildTransportOptions = () => ({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    : undefined,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000
});

const getTransport = () => nodemailer.createTransport(buildTransportOptions());

// Pure message builder: takes the recipient and reset link and returns the
// nodemailer message object. Kept side-effect free so the rendered MIME can be
// asserted in tests without sending mail.
const buildPasswordResetMessage = ({ to, resetLink, expiresInMinutes }) => {
  const minutes = Number.isFinite(expiresInMinutes) ? expiresInMinutes : 15;
  return {
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@ricozcontract.local',
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

const sendPasswordResetEmail = async (args) => {
  if (!isSmtpConfigured()) {
    const error = new Error('SMTP is not configured (SMTP_HOST is missing)');
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }

  await getTransport().sendMail(buildPasswordResetMessage(args));
};

module.exports = {
  isSmtpConfigured,
  buildTransportOptions,
  buildPasswordResetMessage,
  sendPasswordResetEmail
};
