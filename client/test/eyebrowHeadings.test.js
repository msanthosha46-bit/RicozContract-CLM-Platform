'use strict';

// Regression guard for the section headings ("Account workspace",
// "Contract lifecycle", "Compliance workspace", "Contract workspace", ...).
//
// Those twelve labels used to carry `text-sm font-semibold uppercase
// tracking-[0.2em] text-[#1d4ed8]` inline on every page. The light-mode
// overrides in index.css only remap the `text-blue-*` utilities, so the
// arbitrary `#1d4ed8` slipped through and rendered blue against the red brand.
// The treatment now lives in one `.ricoz-eyebrow` class.
//
// These assertions are source-level on purpose: the failure mode was twelve
// copies of a class string drifting apart, which no single rendered page would
// reveal.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src');

const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

const pageFiles = () =>
  fs
    .readdirSync(path.join(SRC, 'pages'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `pages/${name}`);

const css = read('index.css');

test('the old blue eyebrow class is gone from every page', () => {
  const legacy = 'uppercase tracking-[0.2em] text-[#1d4ed8]';
  const offenders = pageFiles().filter((file) => read(file).includes(legacy));

  assert.deepEqual(offenders, [], `blue eyebrow markup returned in: ${offenders.join(', ')}`);
});

test('the section headings all use the shared class', () => {
  // Every page that draws a heading eyebrow must reach for `.ricoz-eyebrow`
  // rather than re-spelling the typography.
  const expected = [
    'ActivityLog.js',
    'ApprovalRequests.js',
    'CreateContract.js',
    'ContractsList.js',
    'EditContract.js',
    'Milestones.js',
    'Obligations.js',
    'Profile.js',
    'RenewalManagement.js',
    'Reports.js',
    'Settings.js',
    'UserManagement.js'
  ];

  const found = pageFiles().filter((file) => read(file).includes('className="ricoz-eyebrow"'));

  assert.deepEqual(found.map((file) => path.basename(file)).sort(), expected.slice().sort());
});

test('the heading gap comes from the class, not a doubled margin', () => {
  // `.ricoz-eyebrow` owns its bottom margin, so a sibling <h1> that also
  // carried `mt-*` would stack two gaps together and drift again.
  for (const file of pageFiles()) {
    const source = read(file);
    const match = source.match(/<p className="ricoz-eyebrow">[^<]*<\/p>\s*\n\s*<h1 className="([^"]*)"/);
    if (!match) continue;
    assert.doesNotMatch(
      match[1],
      /\bmt-\d/,
      `${file}: <h1> after an eyebrow still sets a top margin, which doubles the gap`
    );
  }
});

test('the eyebrow colour is theme-aware, not hard-coded', () => {
  const block = css.match(/\.ricoz-eyebrow\s*\{([^}]*)\}/);
  assert.ok(block, '.ricoz-eyebrow is not defined in index.css');

  assert.match(
    block[1],
    /color:\s*var\(--rz-text-strong\)/,
    'the eyebrow must read a token so light and dark stay in step'
  );
  assert.doesNotMatch(block[1], /text-\[#1d4ed8\]|text-blue-/, 'the blue is gone from the definition');
});

test('--rz-text-strong is dark navy on light and near-white on dark', () => {
  const light = css.match(/:root\s*\{([^}]*)\}/)[1].match(/--rz-text-strong:\s*([^;]+);/);
  const dark = css.match(/\.dark\s*\{([^}]*)\}/)[1].match(/--rz-text-strong:\s*([^;]+);/);

  assert.equal(light[1].trim(), '#0f1d3a', 'light mode expects dark navy');
  assert.equal(dark[1].trim(), '#f1f5f9', 'dark mode expects a readable near-white');
});

test('the eyebrow carries the shared typography', () => {
  const block = css.match(/\.ricoz-eyebrow\s*\{([^}]*)\}/)[1];

  assert.match(block, /font-size:\s*0\.875rem/);
  assert.match(block, /font-weight:\s*700/);
  assert.match(block, /text-transform:\s*uppercase/);
  assert.match(block, /letter-spacing:\s*0\.2em/);
  assert.match(block, /margin-bottom:\s*0\.75rem/);
});

test('Ricoz red is still the accent', () => {
  // The `text-blue-*` utilities are remapped to the brand red, and the red
  // surfaces in light and dark are untouched by the heading change.
  assert.match(css, /\.ricoz-shell main \.text-blue-600,\s*\n?\.ricoz-shell main \.text-blue-700 \{\s*\n?\s*color: #d51d29;/);
  assert.match(css, /\.dark \.ricoz-shell main \[class\*='text-\[#d51d29\]'\] \{\s*\n?\s*color: #ff8a90;/);
});
