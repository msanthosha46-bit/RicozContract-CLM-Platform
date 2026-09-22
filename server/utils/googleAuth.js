const { OAuth2Client } = require('google-auth-library');

// Thin wrapper around the existing Google ID-token verification.
// The ID token is verified server-side against the configured client ID
// (audience); no user information is trusted from the frontend.

const googleClient = new OAuth2Client();

// Public Google OAuth client ID for this project. The environment variable
// always takes precedence; this fallback only keeps zero-config deployments
// (where the dashboard env var was never added) working.
// NOTE: a client ID is public information - it is embedded in every browser
// bundle by design. It is NOT a secret, and no client secret exists in this
// project. Real secrets (JWT_SECRET, SMTP_PASSWORD) stay in env only.
const FALLBACK_GOOGLE_CLIENT_ID =
  '719800879829-ali1g7m187jrfj78cqtg7t362ssn16l5.apps.googleusercontent.com';

const getGoogleClientId = () => process.env.GOOGLE_CLIENT_ID || FALLBACK_GOOGLE_CLIENT_ID;

// Builds the verification options: the token is always checked against the
// server's configured client ID (audience verification). The audience is
// never taken from the request, so a client cannot influence it.
const buildVerifyOptions = (credential) => ({
  idToken: credential,
  audience: getGoogleClientId()
});

const verifyGoogleIdToken = async (credential) => {
  const ticket = await googleClient.verifyIdToken(buildVerifyOptions(credential));
  return ticket.getPayload();
};

module.exports = { verifyGoogleIdToken, buildVerifyOptions, getGoogleClientId };
