#!/usr/bin/env node

// Pre-deploy environment check for the API service.
//
//   node scripts/release-verify.js          config only, no network
//   node scripts/release-verify.js --smtp   also performs a live SMTP handshake
//
// Safe to run in the platform shell. It never connects to MongoDB, never calls
// the Resend API, never sends mail unless --smtp is passed, and never prints a
// secret value: API keys, passwords, tokens, private keys and user/supplier
// addresses are reduced to "set" or to a length. Browser origins are public
// information, so CLIENT_URL and the sender domain are shown.
//
// Exit code 0 = ready to deploy, 1 = at least one blocker was found.

require('dotenv').config();

const path = require('path');
const app = require(path.join(__dirname, '..', 'app'));
const { buildResetLink } = require(path.join(__dirname, '..', 'utils', 'passwordReset'));
const {
  buildTransportOptions,
  extractAddress,
  isResendConfigured,
  isSmtpConfigured,
  sanitizeForLog,
  validateEmailConfig
} = require(path.join(__dirname, '..', 'utils', 'mailer'));

const LIVE_SMTP = process.argv.includes('--smtp');
// The origin the Vercel deployment serves the SPA from. When the browser issues
// a cross-origin preflight to the API it is because the frontend has
// REACT_APP_API_URL set, so CLIENT_URL has to contain this exact value. Pass a
// different origin as the first argument to check a staging deployment.
const EXPECTED_WEB_ORIGIN = process.argv[2] || 'https://ricoz-contract-clm-platform.vercel.app';
const ENFORCE_EXPECTED_ORIGIN = Boolean(process.argv[2]) || require(path.join(__dirname, '..', 'app')).isProduction();
const findings = [];
const record = (level, message) => findings.push({ level, message });

// A .env file on the host is not the platform configuration. When one exists it
// silently supplies any variable the platform did not set, which can mask a
// missing dashboard entry and make this check report values Render never uses.
const dotenvPath = path.join(__dirname, '..', '.env');
const hasDotenv = require('fs').existsSync(dotenvPath);

const PASS = 'PASS  ';
const WARN = 'WARN  ';
const BLOCK = 'BLOCK ';
const line = (label, text) => console.log(`  ${label} ${text}`);
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

// Renders a value without disclosing it.
const mask = (value) => {
  if (value === undefined || value === null || value === '') return '(empty)';
  return `set (${String(value).length} chars)`;
};

const isOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.origin === value.replace(/\/+$/, '');
  } catch {
    return false;
  }
};

console.log('RicozContract API - release environment check');
console.log(`mode: ${LIVE_SMTP ? 'config + live SMTP handshake' : 'config only (no network calls)'}`);

// ---------------------------------------------------------------- startup ---
section('Startup');
if (hasDotenv) {
  line(WARN, 'a .env file exists next to server.js and is filling in gaps in the real environment');
  record('WARN', 'server/.env exists; on a platform host it can shadow the dashboard configuration. The platform env is the source of truth, not this file.');
}
const pkg = require(path.join(__dirname, '..', 'package.json'));
line(PASS, `npm start -> "${pkg.scripts.start}"`);
if (pkg.scripts.start !== 'node server.js') {
  record('BLOCK', `start script is "${pkg.scripts.start}" but the entry point is server/server.js`);
}
line(PASS, `entry point present: server/server.js (${require('fs').existsSync(path.join(__dirname, '..', 'server.js'))})`);
line(PASS, `NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);
line(PASS, `PORT=${process.env.PORT || '(unset, Express default 3000)'}`);

if (app.isProduction()) {
  line(PASS, 'production mode active (CORS fails closed, HSTS enabled)');
} else {
  line(WARN, 'NODE_ENV is not "production": the CORS fail-closed branch is INACTIVE');
  record('WARN', 'NODE_ENV is not "production"; on a production instance this means a missing CLIENT_URL would allow every origin');
}

// ------------------------------------------------------------- credentials ---
section('Required environment');
const required = [
  ['MONGO_URI', 'database connection string'],
  ['JWT_SECRET', 'token signing secret'],
  ['CLIENT_URL', 'frontend origin, also used for reset links'],
  ['GOOGLE_CLIENT_ID', 'audience for Google ID token verification'],
  // These three names come from REQUIRED_ENV in
  // services/storage/supabaseStorage.js. The check used to ask for
  // SUPABASE_SERVICE_ROLE_KEY, which nothing in the codebase reads: on a
  // correctly configured host `release:verify` reported
  // "SUPABASE_SERVICE_ROLE_KEY is EMPTY" and exited 1, so the gate was always
  // red, while the two variables storage actually depends on were never
  // checked at all. Derived from the adapter so the names cannot drift again.
  ...require(path.join(__dirname, '..', 'services', 'storage', 'supabaseStorage'))
    .REQUIRED_ENV.map((name) => [name, `document storage (${name})`])
];
for (const [key, purpose] of required) {
  const value = process.env[key];
  if (value) {
    line(PASS, `${key} ${mask(value)} - ${purpose}`);
  } else {
    line(BLOCK, `${key} is EMPTY - ${purpose}`);
    record('BLOCK', `${key} is not set`);
  }
}

const secret = process.env.JWT_SECRET || '';
if (secret) {
  if (secret.length < 32) {
    line(WARN, `JWT_SECRET is only ${secret.length} chars; 32+ is recommended`);
    record('WARN', 'JWT_SECRET is shorter than 32 characters');
  }
  if (/^(change[-_]?me|your[-_]?secret|secret|test|password|dev)$/i.test(secret)) {
    line(BLOCK, 'JWT_SECRET still looks like a placeholder');
    record('BLOCK', 'JWT_SECRET is a placeholder value');
  }
  if (/^(mongodb(\+srv)?:\/\/)(?![^@/]+@)/i.test(process.env.MONGO_URI || '')) {
    line(WARN, 'MONGO_URI has no embedded credentials, so the database is unauthenticated');
    record('WARN', 'MONGO_URI contains no user:password credentials');
  }
}

// --------------------------------------------------------------- client url ---
section('CLIENT_URL and CORS');
const allowed = app.getAllowedOrigins();
if (!allowed.length) {
  line(BLOCK, 'CLIENT_URL is empty, so no browser origin is allowed');
  record('BLOCK', 'CLIENT_URL is not set: every cross-origin browser call is denied and reset links point at localhost');
} else {
  line(PASS, `allowed origin(s): ${allowed.join(', ')}`);
  // The check that matters for a live Google sign-in: is the real web origin on
  // the list? If not, every preflight is answered without an
  // Access-Control-Allow-Origin header and the browser blocks the request.
  const expected = EXPECTED_WEB_ORIGIN.replace(/\/+$/, '');
  const present = allowed.some((origin) => origin.replace(/\/+$/, '') === expected);
  if (present) {
    line(PASS, `the web origin ${expected} is allowed, so the Google preflight will be answered`);
  } else if (ENFORCE_EXPECTED_ORIGIN) {
    line(BLOCK, `the web origin ${expected} is NOT in CLIENT_URL, so the browser will block the preflight`);
    record('BLOCK', `set CLIENT_URL=${expected} on the API service; Google sign-in fails without it`);
  } else {
    line('      note: the web origin ' + expected + ' is not in CLIENT_URL (not enforced outside production)');
  }
  for (const origin of allowed) {
    if (!isOrigin(origin)) {
      line(BLOCK, `"${origin}" is not a bare scheme://host[:port] origin`);
      record('BLOCK', `CLIENT_URL entry "${origin}" includes a path, port-less form or trailing text; browser origins will never match it`);
    }
    if (/^http:\/\//i.test(origin)) {
      line(BLOCK, `"${origin}" is http; production reset links would be insecure and blocked as mixed content`);
      record('BLOCK', `CLIENT_URL entry "${origin}" is not https`);
    }
  }
}

const resetLink = buildResetLink('diagnostic-token');
const resetBase = resetLink.split('/reset-password')[0];
if (resetBase.startsWith('http://localhost')) {
  line(BLOCK, `reset links resolve to ${resetBase}, which users can never open`);
  record('BLOCK', `password reset links resolve to ${resetBase}; set CLIENT_URL to the real frontend origin`);
} else {
  line(PASS, `reset links resolve to ${resetBase}`);
}

console.log('      CORS matrix (evaluated by the live corsOriginDelegate):');
const candidates = [
  ...allowed.map((origin) => [origin, 'configured origin', PASS]),
  ...allowed.map((origin) => [`${origin}/`, 'same origin, trailing slash', PASS]),
  ...allowed
    .filter((origin) => origin.startsWith('https://'))
    .map((origin) => [origin.replace(/^https:/, 'http:'), 'scheme downgraded to http', BLOCK]),
  ...allowed.map((origin) => [`https://evil.${origin.replace(/^https?:\/\//, '')}`, 'prefixed subdomain', BLOCK]),
  ...allowed.map((origin) => [`https://${origin.replace(/^https?:\/\//, '')}.evil.example`, 'suffixed host', BLOCK]),
  ...allowed.map((origin) => [`${origin}:8443`, 'right host, wrong port', BLOCK]),
  ['https://evil.example', 'unrelated host', BLOCK],
  ['null', 'sandboxed iframe', BLOCK]
];
for (const [origin, description, expectation] of candidates) {
  app.corsOriginDelegate(origin, (error, permitted) => {
    const ok = permitted === (expectation === PASS);
    line(ok ? PASS : WARN, `${permitted ? 'ALLOW' : 'DENY '}  ${origin}  (${description})`);
    if (!ok) record('WARN', `CORS behaved unexpectedly for ${origin}: expected ${expectation === PASS ? 'ALLOW' : 'DENY'}`);
  });
}
app.corsOriginDelegate(undefined, () => {
  line(PASS, 'DENY   (no Origin header)  not a cross-origin request');
});

// -------------------------------------------------------------------- email ---
section('Email (password reset)');
// Resend (HTTPS API) is the primary transport and SMTP is an optional fallback,
// so a missing SMTP block only matters when no Resend key is present. The
// findings come from the mailer's own validation so this check and the running
// service can never disagree.
const emailConfig = validateEmailConfig();
const resendConfigured = isResendConfigured();
const smtpConfigured = isSmtpConfigured();

line(
  emailConfig.transports.length ? PASS : BLOCK,
  `transport order: ${emailConfig.transports.join(' -> ') || 'none configured'}`
);
line(
  resendConfigured ? PASS : WARN,
  `RESEND_API_KEY ${mask(process.env.RESEND_API_KEY)} - primary transport, no outbound SMTP needed`
);

const fromAddress = extractAddress(process.env.EMAIL_FROM);
const fromDomain = (fromAddress || '').split('@')[1] || null;
if (fromAddress) {
  line(PASS, `EMAIL_FROM ${mask(process.env.EMAIL_FROM)} - verified sender required by Resend`);
  line(PASS, `EMAIL_FROM domain: ${fromDomain}`);
} else {
  line(
    resendConfigured ? BLOCK : WARN,
    'EMAIL_FROM is EMPTY - Resend only sends from a verified address, SMTP falls back to SMTP_USER'
  );
  if (resendConfigured) record('BLOCK', 'EMAIL_FROM is not set, so the Resend transport cannot send');
}

// Every SMTP problem is only a blocker while SMTP is the transport that has to
// carry the delivery; otherwise it is a warning about an unused fallback.
const smtpEnv = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD'];
const missingSmtp = smtpEnv.filter((key) => !process.env[key]);
if (!smtpConfigured) {
  line(
    resendConfigured ? WARN : BLOCK,
    `SMTP is not configured${missingSmtp.length ? ` (missing: ${missingSmtp.join(', ')})` : ''}`
  );
  if (!resendConfigured) {
    record('BLOCK', 'SMTP is incomplete (SMTP_HOST is empty) and RESEND_API_KEY is not set, so password reset emails cannot be sent');
  } else {
    record('WARN', 'SMTP is not configured, so there is no fallback if a Resend send fails');
  }
} else {
  const options = buildTransportOptions();
  line(PASS, `SMTP_HOST ${mask(process.env.SMTP_HOST)} host=${options.host} port=${options.port} secure=${options.secure} auth=${mask(options.auth && options.auth.user)}`);
  const userDomain = (process.env.SMTP_USER || '').split('@')[1] || null;
  if (userDomain && fromDomain) {
    if (userDomain === fromDomain) {
      line(PASS, `SMTP_USER and EMAIL_FROM share the same domain (${fromDomain}), so SPF/DKIM can align`);
    } else {
      line(WARN, `SMTP_USER and EMAIL_FROM use different domains, so SPF/DKIM may not align`);
      record('WARN', 'SMTP_USER domain and EMAIL_FROM domain differ');
    }
  }
  if (String(options.port) === '465' && options.secure !== true) {
    line(BLOCK, 'port 465 requires SMTP_SECURE=true for implicit TLS');
    record('BLOCK', 'SMTP_SECURE must be true when SMTP_PORT is 465');
  }
  if (String(options.port) === '587' && options.secure === true) {
    line(WARN, 'port 587 with SMTP_SECURE=true will attempt implicit TLS and usually fails; use false for STARTTLS');
    record('WARN', 'SMTP_PORT 587 normally requires SMTP_SECURE=false');
  }
  if (missingSmtp.length) {
    line(WARN, `optional SMTP variables are empty: ${missingSmtp.join(', ')}`);
  }
}

for (const problem of emailConfig.problems) {
  line(BLOCK, problem);
  record('BLOCK', problem);
}
for (const warning of emailConfig.warnings) {
  line(WARN, warning);
  record('WARN', warning);
}

if (LIVE_SMTP && smtpConfigured) {
  const nodemailer = require(path.join(__dirname, '..', 'node_modules', 'nodemailer'));
  nodemailer
    .createTransport(buildTransportOptions())
    .verify()
    .then((ok) => {
      line(ok ? PASS : BLOCK, `live handshake and authentication succeeded: ${ok}`);
      if (!ok) record('BLOCK', 'SMTP verify() returned false');
      finish();
    })
    .catch((error) => {
      // The code is printed because a mail server's reply is the whole point of
      // the check; the message is sanitised and the password is never echoed.
      line(BLOCK, `live handshake failed: ${error.code || sanitizeForLog(error.message)}`);
      record('BLOCK', `SMTP verify() failed (${error.code || 'unknown'})`);
      finish();
    });
} else {
  if (!smtpConfigured) {
    console.log('      SMTP is not configured, so there is no live handshake to run');
  } else {
    console.log('      run with --smtp to attempt a real connection and authentication');
  }
  finish();
}

function finish() {
  // --------------------------------------------------------------- summary ---
  section('Summary');
  const blockers = findings.filter((f) => f.level === 'BLOCK');
  const warnings = findings.filter((f) => f.level === 'WARN');
  for (const finding of findings) line(finding.level === 'BLOCK' ? BLOCK : WARN, finding.message);

  console.log('');
  if (blockers.length) {
    console.log(`NOT READY - ${blockers.length} blocker(s), ${warnings.length} warning(s). Fix the blockers before deploying.`);
    process.exit(1);
  }
  console.log(`READY - 0 blockers, ${warnings.length} warning(s).`);
  console.log('Note: this checks the API host only. REACT_APP_API_URL and the Google');
  console.log('console "authorized JavaScript origins" live in the frontend project.');
  process.exit(0);
}
