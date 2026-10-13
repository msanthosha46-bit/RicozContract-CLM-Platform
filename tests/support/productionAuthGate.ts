// Explicit opt-in and target guard for the credential-bearing production login
// test (tests/dashboard.spec.ts).
//
// This module only DECIDES whether that test may run. It never reads, logs or
// sends a credential value, and it never performs a network request. The test
// calls evaluateProductionAuthGate(process.env) and skips, before any
// navigation, unless every condition below is met:
//
//   1. RICOZ_ENABLE_PRODUCTION_AUTH_TEST is exactly "1" (an explicit opt-in;
//      merely having RICOZ_TEST_EMAIL / RICOZ_TEST_PASSWORD is never enough).
//   2. Both RICOZ_TEST_EMAIL and RICOZ_TEST_PASSWORD are non-empty.
//   3. RICOZ_PRODUCTION_AUTH_TARGET is exactly the intended production origin.
//
// The expected target is kept as a literal so a changed environment variable
// cannot silently redirect the credentialed login at some other site.

export const OPT_IN_ENV = 'RICOZ_ENABLE_PRODUCTION_AUTH_TEST';
export const OPT_IN_VALUE = '1';
export const TARGET_ENV = 'RICOZ_PRODUCTION_AUTH_TARGET';
export const EMAIL_ENV = 'RICOZ_TEST_EMAIL';
export const PASSWORD_ENV = 'RICOZ_TEST_PASSWORD';

// The one origin the credentialed test is allowed to talk to.
export const EXPECTED_TARGET = 'https://ricoz-contract-clm-platform.vercel.app';
export const ALLOWED_HOST = 'ricoz-contract-clm-platform.vercel.app';

export type ProductionAuthDecision =
  | { run: true; reason: ''; target: string }
  | { run: false; reason: string; target: null };

export type EnvLike = Record<string, string | undefined>;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

// Accepts only a bare https origin on the allow-listed host. Anything else
// (http, another or look-alike host, a path, query, credentials or malformed
// input) is rejected so the gate fails closed.
export const normalizeTarget = (raw: string | undefined): string | null => {
  if (!isNonEmptyString(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== ALLOWED_HOST) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;
  if (url.username || url.password) return null;
  return url.origin;
};

export const evaluateProductionAuthGate = (env: EnvLike = {}): ProductionAuthDecision => {
  if (env[OPT_IN_ENV] !== OPT_IN_VALUE) {
    return {
      run: false,
      target: null,
      reason: `${OPT_IN_ENV} must be exactly "${OPT_IN_VALUE}" to run the production authentication test`
    };
  }
  if (!isNonEmptyString(env[EMAIL_ENV]) || !isNonEmptyString(env[PASSWORD_ENV])) {
    return {
      run: false,
      target: null,
      reason: `${EMAIL_ENV} and ${PASSWORD_ENV} must both be configured`
    };
  }
  const target = normalizeTarget(env[TARGET_ENV]);
  if (!target) {
    return {
      run: false,
      target: null,
      reason: `${TARGET_ENV} must be set to the intended production origin ${EXPECTED_TARGET}`
    };
  }
  return { run: true, target, reason: '' };
};
