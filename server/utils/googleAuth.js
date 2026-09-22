const { OAuth2Client } = require('google-auth-library');

// Thin wrapper around the existing Google ID-token verification.
// The ID token is verified server-side against the configured client ID
// (audience); no user information is trusted from the frontend.

const googleClient = new OAuth2Client();

// Builds the verification options: the token is always checked against the
// GOOGLE_CLIENT_ID configured on the server (audience verification).
const buildVerifyOptions = (credential) => ({
  idToken: credential,
  audience: process.env.GOOGLE_CLIENT_ID
});

const verifyGoogleIdToken = async (credential) => {
  const ticket = await googleClient.verifyIdToken(buildVerifyOptions(credential));
  return ticket.getPayload();
};

module.exports = { verifyGoogleIdToken, buildVerifyOptions };
