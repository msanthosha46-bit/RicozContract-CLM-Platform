import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import {
  evaluateProductionAuthGate,
  normalizeTarget,
  OPT_IN_ENV,
  OPT_IN_VALUE,
  TARGET_ENV,
  EMAIL_ENV,
  PASSWORD_ENV,
  EXPECTED_TARGET
} from './support/productionAuthGate';

// Focused, network-free coverage for the production authentication gate that
// protects tests/dashboard.spec.ts. These tests only exercise the pure decision
// function and the CI configuration; they never submit a login request and
// never run the credential-bearing dashboard test.
const CREDENTIALS = {
  [EMAIL_ENV]: 'someone@example.test',
  [PASSWORD_ENV]: 'placeholder-not-a-real-secret'
};
const INTENDED_TARGET = { [TARGET_ENV]: EXPECTED_TARGET };

test.describe('production auth opt-in gate (no network)', () => {
  test('1. opt-in absent, credentials present -> does not run', () => {
    const decision = evaluateProductionAuthGate({ ...CREDENTIALS, ...INTENDED_TARGET });
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain(OPT_IN_ENV);
  });

  test('2. opt-in set to a value other than "1" -> does not run', () => {
    for (const value of ['true', 'yes', 'on', '0', '01', '2', ' 1', '']) {
      const decision = evaluateProductionAuthGate({ [OPT_IN_ENV]: value, ...CREDENTIALS, ...INTENDED_TARGET });
      expect(decision.run, `opt-in value ${JSON.stringify(value)} must not enable the test`).toBe(false);
    }
  });

  test('3. opt-in is 1 but credentials missing -> does not run', () => {
    expect(evaluateProductionAuthGate({ [OPT_IN_ENV]: OPT_IN_VALUE, ...INTENDED_TARGET }).run).toBe(false);
    expect(
      evaluateProductionAuthGate({ [OPT_IN_ENV]: OPT_IN_VALUE, [EMAIL_ENV]: 'x@y.test', ...INTENDED_TARGET }).run
    ).toBe(false);
    expect(
      evaluateProductionAuthGate({ [OPT_IN_ENV]: OPT_IN_VALUE, [PASSWORD_ENV]: 'x', ...INTENDED_TARGET }).run
    ).toBe(false);
    expect(
      evaluateProductionAuthGate({ [OPT_IN_ENV]: OPT_IN_VALUE, ...CREDENTIALS, [EMAIL_ENV]: '   ', ...INTENDED_TARGET })
        .run
    ).toBe(false);
  });

  test('4. opt-in and credentials present but target unexpected -> refuses', () => {
    const unexpectedTargets: Array<string | undefined> = [
      'https://evil.example.com',
      'https://ricoz-contract-clm-platform.vercel.app.evil.example.com',
      'https://ricoz-contract-clm-platform.vercel.apps.example.com',
      'http://ricoz-contract-clm-platform.vercel.app',
      'https://ricoz-contract-clm-platform.vercel.app/login',
      'https://ricoz-contract-clm-platform.vercel.app/?next=/login',
      'https://user:pass@ricoz-contract-clm-platform.vercel.app',
      'not-a-url',
      '',
      undefined
    ];
    for (const value of unexpectedTargets) {
      const decision = evaluateProductionAuthGate({ [OPT_IN_ENV]: OPT_IN_VALUE, ...CREDENTIALS, [TARGET_ENV]: value });
      expect(decision.run, `target ${JSON.stringify(value)} must not be accepted`).toBe(false);
      expect(decision.target).toBeNull();
    }
  });

  test('5. opt-in, credentials and intended target -> eligible to run', () => {
    const decision = evaluateProductionAuthGate({ [OPT_IN_ENV]: OPT_IN_VALUE, ...CREDENTIALS, ...INTENDED_TARGET });
    expect(decision.run).toBe(true);
    expect(decision.target).toBe(EXPECTED_TARGET);
  });

  test('6. routine CI workflow never enables the opt-in gate', () => {
    const workflowPath = path.resolve(__dirname, '..', '.github', 'workflows', 'playwright.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).not.toContain(OPT_IN_ENV);
    expect(workflow).not.toContain(EMAIL_ENV);
    expect(workflow).not.toContain(PASSWORD_ENV);
    expect(workflow).toContain('--grep-invert');
    expect(workflow).toContain('@production-auth');
  });

  test('normalizeTarget accepts only the exact bare https origin', () => {
    expect(normalizeTarget(EXPECTED_TARGET)).toBe(EXPECTED_TARGET);
    expect(normalizeTarget(`${EXPECTED_TARGET}/`)).toBe(EXPECTED_TARGET);
    expect(normalizeTarget('https://ricoz-contract-clm-platform.vercel.app.evil.test')).toBeNull();
    expect(normalizeTarget('http://ricoz-contract-clm-platform.vercel.app')).toBeNull();
    expect(normalizeTarget(undefined)).toBeNull();
  });
});
