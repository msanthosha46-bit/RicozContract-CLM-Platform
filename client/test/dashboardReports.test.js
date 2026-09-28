'use strict';

// Phase-8 regression guard for the Dashboard and Reports pages.
//
// The defects this exists for, all of which were live in the same place:
//
//   1. On a failed request the Dashboard cleared its data and then rendered
//      the cards anyway, so "0 contracts in your repository" appeared as a
//      real figure. Reports had the same shape of bug in a worse form: a
//      failed fetch left `summary` null, which tripped the "no analytics
//      yet" empty state, so an outage was indistinguishable from an empty
//      repository. Reports also had no retry at all -- `error` was set once
//      and never cleared, and nothing could re-fetch.
//   2. The card captioned "<n> awaiting approval" sat under a currency figure
//      summed over every non-Active contract. Different sets, same card.
//   3. "Workflow status" was described as "latest agreements in motion" and
//      rendered `recentContracts.slice(0, 3)` -- byte-identical to the
//      "Recent contracts" panel beside it, with no relationship to workflow
//      state at all.
//   4. The Contracts page offered 5 of the 9 contract statuses and 4 of the 7
//      contract types, so the rest could not be filtered at all, and it could
//      not read a filter from the URL for the dashboard/report panels to link
//      into. "Showing 20 of 137" was also shown on page 3, where rows 41-60
//      were on screen.
//   5. The Reports metric figures used bare palette utilities. index.css
//      rewrites `.ricoz-shell main .text-blue-600` to the brand red #d51d29,
//      so "Renewals" painted in the same red as "Overdue"; and the bare
//      emerald/amber/orange utilities carry no dark variant, so they kept
//      light-theme weight on the dark card.
//
// Style matches the other suites in this folder: parse the real source, and
// compute contrast from the real theme tokens rather than asserting on
// class names alone.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Source with comments removed, for assertions about what the page *does*. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

const dashboardSrc = read('src/pages/Dashboard.js');
const reportsSrc = read('src/pages/Reports.js');
const listSrc = read('src/pages/ContractsList.js');
const dashboard = stripComments(dashboardSrc);
const reports = stripComments(reportsSrc);
const list = stripComments(listSrc);
const css = read('src/index.css');
const serverRoot = path.join(ROOT, '..', 'server');
const readServer = (rel) => fs.readFileSync(path.join(serverRoot, rel), 'utf8');

/* ---------------- colour maths, same as the other suites ---------------- */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

const token = (name) => {
  const block = css.slice(0, css.indexOf('}', css.indexOf(`--${name}:`)));
  return block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))[1];
};
const darkToken = (name) => {
  const block = css.slice(css.indexOf('.dark {'));
  return block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))[1];
};
const CARD = { light: token('rz-surface'), dark: darkToken('rz-surface') };

// Classes index.css rewrites onto a theme token, so they need no `dark:`
// variant of their own. The rules are unlayered and therefore outrank a
// Tailwind `dark:` utility, which is exactly why the Dashboard uses bare
// `text-[#0f1d3a]` for its headings.
const THEME_REWRITES = {
  'text-[#0f172a]': () => darkToken('rz-text-strong'),
  'text-[#0f1d3a]': () => darkToken('rz-text-strong')
};

/* ---------------- the tone map ---------------- */

const toneMap = (() => {
  const block = reports.slice(
    reports.indexOf('const METRIC_TONE'),
    reports.indexOf('};', reports.indexOf('const METRIC_TONE'))
  );
  const out = {};
  for (const [, key, value] of block.matchAll(/(\w+):\s*'([^']+)'/g)) out[key] = value;
  return out;
})();

// The palette steps the tones are allowed to name, so a contrast claim is
// computed from a real colour rather than trusted. Any step the pages start
// using has to be added here or the test fails loudly.
const PALETTE = {
  'emerald-300': '#6ee7b7',
  'amber-300': '#fcd34d',
  'orange-300': '#fdba74',
  'rose-300': '#fda4af'
};

const resolveColor = (cls) => {
  if (/^#[0-9a-fA-F]{6}$/.test(cls)) return cls;
  const literal = cls.match(/^text-\[(#[0-9a-fA-F]{6})\]$/);
  if (literal) return literal[1];
  const step = cls.match(/^text-([a-z]+-\d{3})$/);
  if (step) {
    assert.ok(PALETTE[step[1]], `unknown palette step "${step[1]}"; add it to the test lookup`);
    return PALETTE[step[1]];
  }
  return assert.fail(`cannot resolve the colour in "${cls}"`);
};

/** The colour a tone paints with in each theme. */
const tonePair = (key, cls) => {
  const light = cls.match(/(?:^|\s)(text-\[#[0-9a-fA-F]{6}\]|text-slate-\d{3})/);
  assert.ok(light, `${key}: no light-theme value in "${cls}"`);
  const dark = cls.match(/dark:(text-\[#[0-9a-fA-F]{6}\]|text-slate-\d{3}|text-[a-z]+-\d{3})/);
  if (dark) return [resolveColor(light[1]), resolveColor(dark[1])];
  assert.ok(
    THEME_REWRITES[light[1]],
    `${key} has no dark-theme value and index.css does not rewrite "${light[1]}"; add a dark: pair`
  );
  return [resolveColor(light[1]), THEME_REWRITES[light[1]]()];
};

test('the two theme card colours are the ones the figures sit on', () => {
  assert.equal(CARD.light, '#ffffff', 'light --rz-surface moved; revisit the light-theme maths');
  assert.equal(CARD.dark, '#141c2e', 'dark --rz-surface moved; revisit the dark-theme maths');
});

test('every Reports metric tone resolves to a colour in both themes', () => {
  const used = Object.keys(toneMap);
  assert.equal(used.length, 6, `expected a tone per metric card, found ${used.length}`);
  for (const key of used) {
    const [light, dark] = tonePair(key, toneMap[key]);
    assert.match(light, /^#[0-9a-f]{6}$/);
    assert.match(dark, /^#[0-9a-f]{6}$/);
  }
});

test('every Reports metric figure clears WCAG AA in both themes', () => {
  for (const [key, cls] of Object.entries(toneMap)) {
    const [light, dark] = tonePair(key, cls);
    const onLight = contrast(light, CARD.light);
    const onDark = contrast(dark, CARD.dark);
    assert.ok(onLight >= 4.5, `${key} light is ${onLight.toFixed(2)}:1, below AA`);
    assert.ok(onDark >= 4.5, `${key} dark is ${onDark.toFixed(2)}:1, below AA`);
  }
});

test('the Reports figures no longer reach for a utility index.css recolours', () => {
  // The trap: `.ricoz-shell main .text-blue-600` is forced to brand red, so a
  // blue figure renders as an alert-coloured figure in both themes.
  assert.match(
    css,
    /\.ricoz-shell main \.text-blue-600,\s*\.ricoz-shell main \.text-blue-700 \{\s*color: #d51d29;/,
    'index.css no longer rewrites text-blue-600, so this guard can be revisited'
  );
  for (const [key, cls] of Object.entries(toneMap)) {
    assert.doesNotMatch(cls, /text-blue-/, `${key} uses the blue utility index.css repaints: ${cls}`);
    // A bare palette step has no dark variant, so it keeps its light weight on
    // the dark card. Hex literals and dark: pairs are the only safe forms.
    const bare = cls.match(/(?:^|\s)text-(?:emerald|amber|orange|red|rose|blue|sky|indigo)-\d{3}/g) || [];
    for (const utility of bare) {
      assert.match(cls, /dark:/, `${key} uses ${utility.trim()} with no dark variant`);
    }
  }
  assert.doesNotMatch(toneMap.renewals, /#d51d29/, 'the Renewals tone is still brand red');
  // The figures must not collide: red means "overdue" here.
  const tones = Object.values(toneMap).map((cls) => tonePair('x', cls).join('|'));
  assert.equal(new Set(tones).size, tones.length, 'two metric figures share a colour');
});

test('the Reports figures use the same palette steps as the status pills', () => {
  // Each accent should track the StatusBadge entry for the status it reports,
  // so a figure and its badge never read as two different colours.
  const badge = stripComments(read('src/components/Layout/Common/StatusBadge.js'));
  const styles = badge.slice(badge.indexOf('const styles'), badge.indexOf('const StatusBadge'));
  for (const [tone, status] of [['active', 'Approved'], ['pending', 'Pending Approval'], ['overdue', 'Overdue']]) {
    const entry = styles.match(new RegExp(`'?${status}'?\\s*:\\s*'([^']+)'`));
    assert.ok(entry, `StatusBadge has no entry for ${status}`);
    const badgeLight = entry[1].match(/text-\[(#[0-9a-f]{6})\]/);
    const badgeDark = entry[1].match(/dark:(text-[a-z]+-\d{3}|text-\[#[0-9a-f]{6}\])/);
    assert.ok(badgeLight && badgeDark, `could not read the ${status} pill colours from "${entry[1]}"`);
    const [light, dark] = tonePair(tone, toneMap[tone]);
    assert.equal(light, badgeLight[1], `${tone} light step should match the ${status} pill`);
    assert.equal(resolveColor(dark), resolveColor(badgeDark[1]), `${tone} dark step should match the ${status} pill`);
  }
});

/* ---------------- failure is not an empty repository ---------------- */

test('the Reports page can retry and clears the error on success', () => {
  assert.match(reports, /const fetchSummary = async \(\) => \{/, 'fetchSummary must be reusable for a retry');
  assert.match(reports, /onClick=\{fetchSummary\}/, 'no control re-runs the request');
  assert.match(reports, /setError\(''\);/, 'the error is never cleared before retrying');
  assert.match(reports, /role="alert"/, 'the error banner should announce itself');
});

test('a failed Reports request is not reported as an empty repository', () => {
  assert.match(reports, /const failed = !summary;/);
  assert.match(reports, /\{failed \?/, 'there is no branch for a request that never succeeded');
  assert.match(reports, /title="Reports unavailable"/);
  // The empty state must additionally require a successful response.
  assert.match(reports, /const isEmpty = Boolean\(summary\) &&/, 'an absent summary is treated as an empty repository');
});

test('a failed Dashboard request does not render the figures as zeroes', () => {
  // The cards are inside the data branch, so an error cannot paint
  // "0 contracts in your repository".
  const guard = dashboard.indexOf('{!metrics ? (');
  assert.ok(guard > 0, 'the Dashboard has no branch for "loaded but empty"');
  const cards = dashboard.indexOf('{summaryCards.map(');
  assert.ok(cards > guard, 'the summary cards render outside the data branch');
  assert.match(dashboard, /\{!metrics \? \([\s\S]*?\) : \(\s*<>/, 'the data branch is not a guarded fragment');
  assert.match(dashboard, /setMetrics\(null\)/, 'a failure still clears the stale payload');
  assert.match(dashboard, /role="alert"/, 'the Dashboard error banner should announce itself');
  assert.match(dashboard, /onClick=\{fetchDashboardData\}/, 'the retry button is gone');
});

test('a successful reload replaces the error banner', () => {
  // Both pages clear `error` at the top of the fetch, before the request.
  for (const [name, src] of [['Reports', reports], ['Dashboard', dashboard]]) {
    const body = src.slice(src.indexOf('async () => {'), src.indexOf('} catch', src.indexOf('async () => {')));
    assert.match(body, /setError\(''\)/, `${name} does not clear the error before fetching`);
  }
});

/* ---------------- captions describe the figure above them ---------------- */

test('the non-active figure is captioned by the population it sums over', () => {
  // total - active is exactly the contract set behind `outstandingLines`, so
  // the caption can no longer claim a narrower "awaiting approval" set.
  assert.match(dashboard, /const notActiveCount = \(metrics\) => Math\.max\(\(metrics\?\.total \|\| 0\) - \(metrics\?\.active \|\| 0\), 0\)/);
  assert.match(dashboard, /\$\{notActiveCount\(metrics\)\} contracts outside Active status/);
  assert.doesNotMatch(dashboard, /awaiting approval/i, 'the misleading caption is back');
  assert.doesNotMatch(dashboard, /Awaiting action/, 'the Value snapshot row claimed pending action');
  assert.match(dashboard, /Outside Active/);
});

test('the Expiring soon caption states the statuses the figure covers', () => {
  assert.match(dashboard, /Active or approved, ending within 30 days/);
});

test('the status chart states the total it is drawn from', () => {
  assert.match(dashboard, /contracts in total/);
});

/* ---------------- the workflow panel is actually about workflow ---------------- */

test('the workflow panel is built from the status breakdown, not the recent list', () => {
  assert.match(dashboard, /const IN_FLIGHT = \['Draft', 'Pending Review', 'Pending Approval', 'Approved'\]/);
  assert.match(dashboard, /statusBreakdown\.find\(/);
  // The old panel rendered recentContracts twice on the page.
  const recentUses = dashboard.match(/recentContracts\.slice\(0, 3\)/g) || [];
  assert.equal(recentUses.length, 1, 'the recent list should be rendered once');
  assert.match(dashboard, /Waiting on a review or approval step|waiting on a review or approval step/);
});

test('the workflow rows link to a filter the Contracts page can apply', () => {
  assert.match(dashboard, /to=\{`\/contracts\?status=\$\{encodeURIComponent\(status\)\}`\}/);  assert.match(list, /searchParams\.get\('status'\)/, 'ContractsList ignores a status in the URL');
  assert.match(list, /VALID_STATUSES\.includes\(rawStatus\)/, 'and does not validate it');
});

test('each report breakdown row links to a filter the Contracts page can apply', () => {
  for (const key of ['status', 'type']) {
    assert.match(reports, new RegExp(`filterKey="${key}"`), `no breakdown links to ?${key}=`);
    assert.match(reports, /to=\{`\/contracts\?\$\{filterKey\}=/);
    assert.match(list, new RegExp(`searchParams\\.get\\('${key}'\\)`), `ContractsList ignores a ${key} in the URL`);
    assert.match(list, new RegExp(`clean\\.${key} = next\\.${key}`), `ContractsList never writes a ${key} back to the URL`);
  }
});

/* ---------------- filter coverage ---------------- */

const serverStatusEnum = () =>
  [...readServer('models/Contract.js')
    .match(/status:\s*\{[\s\S]*?enum:\s*\[([^\]]*)\]/)[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);

const serverTypeEnum = () =>
  [...readServer('models/Contract.js')
    .match(/type:\s*\{[\s\S]*?enum:\s*\[([^\]]*)\]/)[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('the Contracts status filter offers every status the server can return', () => {
  const statuses = serverStatusEnum();
  assert.equal(statuses.length, 9, 'expected nine contract statuses');
  // Options are generated from VALID_STATUSES rather than hand-listed, so a
  // new status cannot silently become unfilterable again.
  assert.match(list, /import \{ VALID_STATUSES \} from '\.\.\/utils\/contractTransitions';/);
  assert.match(list, /\{VALID_STATUSES\.map\(\(value\) => \(/);
  const clientEnum = [...read('src/utils/contractTransitions.js')
    .match(/VALID_STATUSES = \[([\s\S]*?)\]/)[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(clientEnum, statuses, 'the frontend lifecycle mirror has drifted from the model');
});

test('the Contracts type filter offers every type the server can return', () => {
  const types = serverTypeEnum();
  assert.equal(types.length, 7, 'expected seven contract types');
  const block = list.slice(
    list.indexOf('const CONTRACT_TYPES'),
    list.indexOf('];', list.indexOf('const CONTRACT_TYPES'))
  );
  const offered = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(offered, types, 'the type filter list is out of step with the schema');
  assert.match(list, /\{CONTRACT_TYPES\.map\(\(value\) => \(/);
});

test('an unrecognised filter in the URL is dropped instead of being sent', () => {
  // An unknown status is a 400 from the API and an unknown type is a silent
  // empty list, so both are stripped before the request goes out.
  assert.match(list, /const status = VALID_STATUSES\.includes\(rawStatus\) \? rawStatus : '';/);
  assert.match(list, /const type = CONTRACT_TYPES\.includes\(rawType\) \? rawType : '';/);
  const query = list.slice(list.indexOf('const query = new URLSearchParams'), list.indexOf('API.get'));
  assert.match(query, /status, type, page, limit: PAGE_SIZE/);
});

test('the pagination summary counts rows seen, not rows per page', () => {
  // page * PAGE_SIZE: "Showing 20 of 137" was wrong on page 3, where 60 rows
  // had been seen.
  assert.match(list, /const resultsCount = Math\.min\(page \* PAGE_SIZE, total\);/);
  assert.doesNotMatch(list, /Math\.min\(total, PAGE_SIZE\)/);
});

test('pagination and filters share one source of truth', () => {
  // React Router reuses the component when only the query string changes, so
  // mirrored useState would have kept a stale filter when the dashboard or
  // reports link was followed.
  assert.match(list, /const \[searchParams, setSearchParams\] = useSearchParams\(\);/);
  assert.doesNotMatch(list, /useState\(\(\) => searchParams\.get/, 'a filter is mirrored into state');
  assert.doesNotMatch(list, /setStatus\(/, 'status is held in state');
  assert.doesNotMatch(list, /setType\(/, 'type is held in state');
  assert.doesNotMatch(list, /setPage\(/, 'page is held in state');
  assert.match(list, /if \(Number\(next\.page\) > 1\) clean\.page = next\.page;/, 'page 1 should stay out of the URL');
  assert.match(list, /setSearchParams\(clean, \{ replace: true \}\)/);
});

test('filter changes reset to the first page', () => {
  for (const handler of [/updateParams\(\{ status: e\.target\.value, page: '1' \}\)/, /updateParams\(\{ type: e\.target\.value, page: '1' \}\)/]) {
    assert.match(list, handler);
  }
  assert.match(list, /const resetToFirstPage = \(\) => \{[\s\S]*updateParams\(\{ page: '1' \}\)/, 'searching does not reset the page');
});

/* ---------------- responsive layout ---------------- */

// There is no browser test runner here, so -- as in mobileOverflow.test.js --
// the geometry is checked from the real classNames rather than by rendering.
// The failure mode these rows had in common is a flex child that cannot shrink:
// a currency figure and a status pill are both unbreakable, so without
// min-w-0 + truncate on the flexible sibling the row pushes a horizontal
// scrollbar on a 320px card.

/** The className of the element that opens a given `key={...}` row. */
const rowClassName = (src, keyExpr) => {
  const anchor = src.indexOf(keyExpr);
  assert.notEqual(anchor, -1, `no ${keyExpr} in the source`);
  const rest = src.slice(anchor);
  const anchor2 = rest.indexOf('className="');
  const start = anchor2 + 'className="'.length;
  return rest.slice(start, rest.indexOf('"', start));
};

const has = (className, utility) => new RegExp(`(?:^|\\s)${utility}(?:\\s|$)`).test(className);

test('every flex row that pairs text with a figure can shrink', () => {
  const rows = [
    ['Dashboard recent contract', rowClassName(dashboard, 'to={`/contracts/${contract._id}`}')],
    ['Dashboard workflow row', rowClassName(dashboard, 'to={`/contracts?status=')],
    ['Reports breakdown row', rowClassName(reports, 'to={`/contracts?${filterKey}=')]
  ];

  for (const [label, className] of rows) {
    assert.match(className, /items-center/, `${label} row lost its flex layout`);
    assert.match(className, /gap-3/, `${label} row needs a gap so the two ends cannot touch`);
    // The row is a Link on the dashboard/reports pages, so the browser
    // underlines/visits it; keep the hover affordance explicit as before.
    assert.match(className, /transition|hover:/, `${label} row lost its hover affordance`);
  }
});

test('the flexible child of those rows is allowed to shrink and truncate', () => {
  // min-w-0 on the flex child is what lets truncate engage; without it the
  // child keeps its min-content width and the row overflows instead.
  assert.match(dashboard, /className="min-w-0"[\s\S]{0,120}?truncate/, 'the recent contract number cannot shrink');
  assert.match(dashboard, /shrink-0 font-bold tabular-nums/, 'the recent contract amount must not be squeezed');
  assert.match(dashboard, /shrink-0 text-sm font-bold tabular-nums/, 'the workflow count must not be squeezed');
  assert.match(reports, /flex min-w-0 items-center gap-2/, 'the breakdown label cannot shrink');
  assert.match(reports, /shrink-0 text-sm font-bold tabular-nums/, 'the breakdown count must not be squeezed');
  // StatusBadge sets its own shrink-0; the workflow row must not re-wrap it.
  assert.match(dashboard, /<StatusBadge status=\{status\} \/>/);
});

test('no arbitrary fixed width was introduced on the three pages', () => {
  // A `w-[Npx]` (or a scale width used as a layout width, as the topbar popup
  // had with w-80) cannot reflow on a 320px screen. Lucide's `w-4`/`w-5` icon
  // sizes are the only w-* on these pages and are not layout widths.
  for (const [name, src] of [['Dashboard', dashboard], ['Reports', reports], ['ContractsList', list]]) {
    const arbitrary = src.match(/(?:^|\s)w-\[[^\]]+\]/g) || [];
    assert.deepEqual(arbitrary, [], `${name} gained a fixed width: ${arbitrary.join(' ')}`);
  }
  // The rows added here are fluid by construction.
  for (const className of [
    rowClassName(dashboard, 'to={`/contracts/${contract._id}`}'),
    rowClassName(dashboard, 'to={`/contracts?status='),
    rowClassName(reports, 'to={`/contracts?${filterKey}=')
  ]) {
    assert.doesNotMatch(className, /(?:^|\s)w-/, `a row is given a fixed width: "${className}"`);
  }
});

test('the Reports header and card grid reflow instead of scrolling', () => {
  // Stacked below md, side by side from md up, so the Refresh control drops
  // under the heading on a phone rather than beside it.
  assert.match(reports, /flex flex-col gap-4 md:flex-row md:items-end md:justify-between/);
  assert.match(reports, /self-start/);
  assert.match(reports, /md:self-auto/, 'the refresh button does not re-align at md');
  // One column of cards on a phone; six only on a wide desktop.
  assert.match(reports, /grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6/);
  // The two breakdowns stack below lg.
  assert.match(reports, /grid gap-6 lg:grid-cols-2/);
});

test('the Dashboard grid breakpoints are unchanged', () => {
  assert.match(dashboard, /grid gap-4 md:grid-cols-2 xl:grid-cols-4/);
  assert.match(dashboard, /xl:grid-cols-\[minmax\(0,2\.2fr\)_minmax\(280px,1fr\)\]/);
  assert.match(dashboard, /grid gap-5 xl:grid-cols-3/);
  // The chart container keeps an explicit height; ResponsiveContainer needs one
  // or the bar chart collapses to nothing.
  assert.match(dashboard, /<div className="mt-6 h-64">/);
});

test('the error banners can wrap on a narrow screen', () => {
  // A long server message next to a Retry button would otherwise force the
  // banner wider than the viewport.
  assert.match(reports, /flex flex-wrap items-center justify-between gap-4/);
  assert.match(dashboard, /flex flex-wrap items-center justify-between gap-4/);
  assert.match(reports, /shrink-0 items-center gap-2/, 'the retry button must not be squeezed');
});

/* ---------------- preserved behaviour ---------------- */

test('role-based access on the Dashboard is unchanged', () => {
  assert.match(dashboard, /const canViewReports = \['Admin', 'Manager'\]\.includes\(user\?\.role\);/);
  assert.match(dashboard, /\{canViewReports && \(\s*<Link to="\/reports"/, 'the reports link is no longer role-gated');
  assert.match(dashboard, /\{canViewReports && <Link to="\/reports" className="text-sm font-bold/);
});

test('the reports endpoints and their callers are unchanged', () => {
  assert.match(dashboard, /API\.get\('\/reports\/dashboard'\)/);
  assert.match(reports, /API\.get\('\/reports\/summary'\)/);
  assert.match(list, /API\.get\(`\/contracts\?\$\{query\}`\)/);
});

test('the status vocabulary the pages render is still the shared badge', () => {
  assert.match(dashboard, /<StatusBadge status=\{contract\.status\} \/>/, 'recent contracts lost the shared badge');
  assert.match(dashboard, /<StatusBadge status=\{status\} \/>/, 'the workflow rows lost the shared badge');
});

test('loading, empty and error states are all still present', () => {
  assert.match(dashboard, /if \(loading\) \{[\s\S]*PageSkeleton/);
  assert.match(reports, /if \(loading && !loaded\) \{[\s\S]*PageSkeleton/, 'a background refresh would blank the page');
  assert.match(reports, /const \[loaded, setLoaded\] = useState\(false\)/, 'a refresh must not flash the empty state');
  assert.match(dashboard, /title="No contract data yet"/);
  assert.match(reports, /title="No analytics yet"/);
  assert.match(reports, /emptyTitle="No status breakdown"/);
  assert.match(reports, /emptyTitle="No type breakdown"/);
});

test('branding and layout are preserved', () => {
  // Brand red, navy and the responsive grids the pages shipped with.
  for (const src of [dashboard, reports, list]) {
    assert.match(src, /#d51d29/, 'the brand red left the page');
  }
  assert.match(dashboard, /text-\[#0f1d3a\]/, 'the navy heading colour left the Dashboard');
  assert.match(dashboard, /xl:grid-cols-\[minmax\(0,2\.2fr\)_minmax\(280px,1fr\)\]/);
  assert.match(dashboard, /xl:grid-cols-4/);
  assert.match(reports, /xl:grid-cols-6/);
  assert.match(reports, /lg:grid-cols-2/);
  assert.match(reports, /mt-2 text-3xl font-bold tabular-nums/, 'the figure styling changed');
});
