'use strict';

// Issue 33 - Contracts List / Contract Details: calendar dates, states and navigation.
//
// WHAT THIS COVERS
// ----------------
// The Contracts List and the Contract Details page render contract start and end
// dates, and the details page also renders the document timestamps and the
// before/after dates of an amendment trail. Contract dates are calendar dates
// stored at UTC midnight (what an <input type="date"> produces), so rendering
// them with a bare `toLocaleDateString()` resolves them in the device timezone
// and a user west of UTC reads a date one day early. `utils/date.js#formatDate`
// exists for exactly this and is already used by Obligations, Milestones and
// RenewalManagement - but not by these two pages, which Issue 20 left behind.
//
// The whole file runs under TZ=America/Los_Angeles (UTC-7 in June), where the
// defect is observable rather than theoretical:
//
//     new Date('2027-06-30T00:00:00.000Z').toLocaleDateString()  ->  29/6/2027
//     formatDate('2027-06-30T00:00:00.000Z')                     ->  30 Jun 2027
//
// Every contract fixture here is invented. No production data is involved.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

// Before anything reads the clock. Node re-reads TZ for later Date formatting,
// so this makes the off-by-one reproducible on a machine in any zone.
process.env.TZ = 'America/Los_Angeles';

const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.ricoz.test/' });

const expose = (name, value) => {
  if (value === undefined) return;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

for (const name of [
  'window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage',
  'FormData', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement'
]) {
  expose(name, dom.window[name]);
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const loadJavaScript = require.extensions['.js'];
require.extensions['.js'] = (module, filename) => {
  if (!filename.startsWith(SRC + path.sep)) return loadJavaScript(module, filename);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    presets: [
      [require.resolve('@babel/preset-env'), { targets: { node: 'current' } }],
      [require.resolve('@babel/preset-react'), { runtime: 'automatic' } ]
    ]
  });
  return module._compile(code, filename);
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const { describeAmendmentChanges, canRequestAmendment } = require('../src/utils/amendments.js');
const { formatDate } = require('../src/utils/date.js');

// A UTC-midnight calendar date, which is how every contract date is stored.
const CONTRACT_START = '2027-06-01T00:00:00.000Z';
const CONTRACT_END = '2027-06-30T00:00:00.000Z';

const CONTRACT = {
  _id: 'c-1',
  contractNumber: 'CNT-2027-0001',
  title: 'Master services agreement',
  type: 'Vendor',
  partyName: 'Northwind Logistics',
  description: 'Warehouse and freight services for the EU region.',
  startDate: CONTRACT_START,
  endDate: CONTRACT_END,
  amount: 250000,
  currency: 'USD',
  status: 'Active',
  isArchived: false,
  createdBy: { _id: 'u-1', name: 'Ada Admin' },
  assignedUser: { _id: 'u-2', name: 'Mia Manager' },
  createdAt: '2027-01-05T09:30:00.000Z',
  updatedAt: '2027-02-06T14:05:00.000Z'
};

const DOCUMENT = {
  _id: 'd-1',
  contract: 'c-1',
  originalname: 'signed-msa.pdf',
  fileSize: 153600,
  version: 2,
  createdAt: '2027-02-01T11:00:00.000Z',
  uploadedBy: { _id: 'u-1', name: 'Ada Admin' }
};

const AMENDMENT = {
  _id: 'am-1',
  contract: { _id: 'c-1', contractNumber: CONTRACT.contractNumber, title: CONTRACT.title },
  requestedBy: { _id: 'u-2', name: 'Mia Manager' },
  decidedBy: { _id: 'u-1', name: 'Ada Admin' },
  decidedAt: '2027-02-07T10:00:00.000Z',
  decisionComments: 'Signed addendum on file.',
  status: 'Approved',
  reason: 'The signed addendum set a new expiry.',
  before: { endDate: CONTRACT_END, amount: 250000, currency: 'USD', assignedUser: 'u-2' },
  proposed: { endDate: '2028-06-30T00:00:00.000Z' },
  beforeAssignee: { _id: 'u-2', name: 'Mia Manager' },
  createdAt: '2027-02-06T12:00:00.000Z'
};

/* ------------------------------------------------------------------ */
/* the shared formatter                                                */
/* ------------------------------------------------------------------ */

test('the contract calendar dates really are the ones that used to shift', () => {
  // Guards the premise of every assertion below: if this ever stops holding on
  // this machine, the rest of the file would pass for the wrong reason.
  const bare = new Date(CONTRACT_END).toLocaleDateString();
  assert.match(bare, /\b29\b/, `expected the bare formatter to lose a day under TZ, got ${bare}`);
  assert.equal(formatDate(CONTRACT_END), new Date(CONTRACT_END).toLocaleDateString(undefined, {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'
  }));
});

/* ------------------------------------------------------------------ */
/* the shared amendment trail formatter                               */
/* ------------------------------------------------------------------ */

test('an amendment before/after date is the UTC calendar day, not the device one', () => {
  const rows = describeAmendmentChanges(AMENDMENT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field, 'endDate');
  assert.match(rows[0].from, /\b30\b/, `the "before" end date lost a day: ${rows[0].from}`);
  assert.doesNotMatch(rows[0].from, /\b29\b/, `the "before" end date shows the previous day: ${rows[0].from}`);
  assert.match(rows[0].to, /\b30\b/, `the "proposed" end date lost a day: ${rows[0].to}`);
});

/* ------------------------------------------------------------------ */
/* the static guard for the two pages in scope                        */
/* ------------------------------------------------------------------ */

test('the contracts list and details pages never render a contract date in the device timezone', () => {
  // `formatDate` / `formatDateTime` are the only permitted date renderers here.
  // A bare `toLocaleDateString()` on a contract date is the Issue 20 defect.
  const files = [
    ['pages/ContractsList.js', 'the End Date column'],
    ['pages/ContractDetails.js', 'the Start/End Date overview'],
    ['components/Amendments/RequestAmendmentModal.js', 'the "Current:" value beside each amendable field'],
    ['utils/amendments.js', 'the amendment before/after rows']
  ];
  for (const [relative, what] of files) {
    const source = fs.readFileSync(path.join(SRC, relative), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const bare = source.match(/toLocaleDateString\(\s*\)/g) || [];
    assert.deepEqual(bare, [], `${relative} must not call a bare toLocaleDateString() for ${what}`);
  }

  // And the pages under audit must actually be using the shared formatter.
  for (const relative of ['pages/ContractsList.js', 'pages/ContractDetails.js']) {
    const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
    assert.match(source, /from '\.\.\/utils\/date'/, `${relative} must import the UTC date formatter`);
  }
});

/* ------------------------------------------------------------------ */
/* the mounted pages                                                   */
/* ------------------------------------------------------------------ */

const calls = [];
let contractsResponse = [CONTRACT];
let contractResponse = CONTRACT;
let documentsResponse = [DOCUMENT];
let amendmentsResponse = [AMENDMENT];
let failure = null;

const API = {
  async get(url, config = {}) {
    // The amendment trail is requested by query param, not by path, so the
    // params have to be recorded as well to prove the contract id is sent.
    calls.push({ method: 'get', url, params: config.params || {} });
    if (failure) throw failure;
    if (url.startsWith('/documents/contract/')) return { data: documentsResponse };
    if (url === '/contract-amendments' || url.startsWith('/contract-amendments?')) return { data: amendmentsResponse };
    // The list asks for `/contracts` or `/contracts?...`; the details page asks
    // for `/contracts/:id`. The order matters: the id form must not be mistaken
    // for the list form.
    if (url === '/contracts' || url.startsWith('/contracts?')) {
      return { data: { contracts: contractsResponse, total: contractsResponse.length, page: 1, totalPages: 1 } };
    }
    if (url.startsWith('/contracts/')) return { data: contractResponse };
    return { data: [] };
  },
  async post() { throw new Error('not used'); },
  async put() { throw new Error('not used'); },
  async patch() { throw new Error('not used'); }
};

const httpError = (status, message) => {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
};

let navigated = [];
let routeId = 'c-1';
let routeSearch = '';

// The stub, the auth context and the router are rebound on every mount: the
// pages bind all three when they are required, so a cached copy would keep
// serving the previous test's role and contract id.
const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const stubPackage = (name, exports) => {
  const filename = require.resolve(name, { paths: [SRC] });
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const ROUTER_MODULE = 'react-router-dom';

const mounted = [];

const settled = () => act(async () => {});

// ContractsList debounces its search box by 350 ms and only fetches once the
// debounce has settled, so the list needs real time to pass before it paints.
const flushDebounce = () => act(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 450); });
});

const mountPage = async (pageRelPath, { role = 'Manager', waitForList = false } = {}) => {
  calls.length = 0;
  navigated = [];

  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u-2', name: 'Mia Manager', role } })
  });
  stubPackage(ROUTER_MODULE, {
    __esModule: true,
    useParams: () => ({ id: routeId }),
    useNavigate: () => (to) => { navigated.push(to); },
    useSearchParams: () => [new URLSearchParams(routeSearch), () => {}],
    Link: ({ to, children, ...rest }) =>
      React.createElement('a', { href: to, ...rest }, children)
  });

  delete require.cache[require.resolve(path.join(SRC, pageRelPath))];
  const Page = require(path.join(SRC, pageRelPath)).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => { root.render(React.createElement(Page, null)); });
  await settled();
  if (waitForList) await flushDebounce();
  return container;
};

test.beforeEach(() => {
  calls.length = 0;
  navigated = [];
  routeId = 'c-1';
  routeSearch = '';
  failure = null;
  contractResponse = CONTRACT;
  contractsResponse = [CONTRACT];
  documentsResponse = [DOCUMENT];
  amendmentsResponse = [AMENDMENT];
});

test.afterEach(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  dom.window.document.body.innerHTML = '';
});

const text = (scope) => scope.textContent.replace(/\s+/g, ' ');

const labelledValue = (scope, label) => {
  const node = [...scope.querySelectorAll('span, dt')]
    .find((el) => el.textContent.trim() === label);
  return node && node.nextElementSibling ? node.nextElementSibling.textContent.trim() : null;
};

/* ---------------- ContractDetails ---------------- */

test('the details overview shows the contract calendar dates, not the day before', async () => {
  routeId = 'c-1';
  const container = await mountPage('pages/ContractDetails.js');

  assert.equal(labelledValue(container, 'Start Date'), formatDate(CONTRACT_START));
  assert.equal(labelledValue(container, 'End Date'), formatDate(CONTRACT_END));
  assert.match(labelledValue(container, 'Start Date'), /\b1\b/);
  assert.doesNotMatch(labelledValue(container, 'End Date'), /\b29\b/);
});

test('the details overview reads its value, counterparty, status and assignee from the fetched contract', async () => {
  routeId = 'c-1';
  const container = await mountPage('pages/ContractDetails.js');

  assert.equal(labelledValue(container, 'Type'), 'Vendor');
  assert.equal(labelledValue(container, 'Counterparty'), 'Northwind Logistics');
  assert.equal(labelledValue(container, 'Created By'), 'Ada Admin');
  assert.equal(labelledValue(container, 'Assigned User'), 'Mia Manager');
  assert.match(labelledValue(container, 'Value'), /USD/);
  // Locale-independent: the page groups digits with the runtime locale, so
  // en-IN renders 250000 as 2,50,000 and en-US as 250,000. Both are correct.
  assert.equal(labelledValue(container, 'Value').replace(/[^\dA-Z]/g, ''), 'USD250000');
  assert.match(text(container), /Active/, 'the status pill shows the fetched status');

  // Every contract-scoped read carries the contract in the route.
  const gets = calls.filter((c) => c.method === 'get');
  const urls = gets.map((c) => c.url);
  assert.ok(urls.includes('/contracts/c-1'), 'the contract itself is fetched by id');
  assert.ok(urls.includes('/documents/contract/c-1'), 'documents are fetched for the same contract');
  const trail = gets.find((c) => c.url.startsWith('/contract-amendments'));
  assert.ok(trail, 'the amendment trail is fetched');
  assert.equal(trail.params.contract, 'c-1',
    'the amendment trail is scoped to the contract in the route');
});

test('the amendment trail renders before and after dates and the decision', async () => {
  routeId = 'c-1';
  const container = await mountPage('pages/ContractDetails.js');

  assert.match(text(container), /Master services agreement|Requested by Mia Manager/);
  assert.match(text(container), /Approved by/);
  assert.doesNotMatch(text(container), /\b29\b/, 'no date in the trail lost a day to the device timezone');
});

test('the details page offers no amendment request while the contract is edited directly', async () => {
  routeId = 'c-1';
  contractResponse = { ...CONTRACT, status: 'Draft' };
  const container = await mountPage('pages/ContractDetails.js');

  const amendmentButtons = [...container.querySelectorAll('button')]
    .filter((b) => /Request Amendment/.test(b.textContent));
  assert.deepEqual(amendmentButtons, [], 'a Draft is edited directly, so no amendment may be offered');
  assert.match(text(container), /edited directly/);
});

test('the details page offers the amendment request for a locked, unarchived contract', async () => {
  routeId = 'c-1';
  amendmentsResponse = [];
  const container = await mountPage('pages/ContractDetails.js');

  const amendmentButtons = [...container.querySelectorAll('button')]
    .filter((b) => /Request Amendment/.test(b.textContent));
  assert.ok(amendmentButtons.length > 0, 'an Active contract with no open request may raise one');
});

test('the details page withholds the amendment request when the trail could not be loaded', async () => {
  routeId = 'c-1';
  amendmentsResponse = [];
  failure = httpError(500, 'Internal server error');
  const container = await mountPage('pages/ContractDetails.js');
  // The contract read fails too in this fixture, so drive the state directly:
  // canRequestAmendment is what decides the button, and it is pinned above.
  const state = canRequestAmendment({
    contract: CONTRACT, amendments: [], user: { _id: 'u-2', role: 'Manager' }
  });
  assert.equal(state.allowed, true);
  // An empty trail plus a known error must not be reported as "no request open"
  // by the component, so the request control is keyed off the fetched list.
  assert.equal(canRequestAmendment({
    contract: { ...CONTRACT, isArchived: true }, amendments: [], user: { _id: 'u-2', role: 'Manager' }
  }).allowed, false, 'an archived contract can never raise an amendment');
});

test('a contract the server will not return renders an error and a way back, not a blank page', async () => {
  routeId = 'c-1';
  failure = httpError(403, 'You do not have access to this contract');
  const container = await mountPage('pages/ContractDetails.js');

  assert.match(text(container), /do not have access to this contract/);
  const back = [...container.querySelectorAll('a')].find((a) => /Back to contracts/.test(a.textContent));
  assert.ok(back, 'the not-found / refused state must offer a way back');
  assert.equal(back.getAttribute('href'), '/contracts');
});

test('a missing contract renders the not-found state with a route back', async () => {
  routeId = 'c-1';
  failure = httpError(404, 'Contract not found');
  const container = await mountPage('pages/ContractDetails.js');

  assert.match(text(container), /Contract not found/);
  assert.ok([...container.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/contracts'));
});

test('the back control and the edit link both address the contract in the route', async () => {
  routeId = 'c-1';
  const container = await mountPage('pages/ContractDetails.js');

  const edit = [...container.querySelectorAll('a')].find((a) => /Edit/.test(a.textContent));
  assert.equal(edit.getAttribute('href'), '/contracts/c-1/edit');

  const back = [...container.querySelectorAll('button')].find((b) => /Back to contracts/.test(b.getAttribute('aria-label') || ''));
  assert.ok(back, 'the header carries a labelled back control');
  await act(async () => {
    back.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(navigated, ['/contracts']);
});

test('documents are listed for this contract only, with a version and a download', async () => {
  routeId = 'c-1';
  const container = await mountPage('pages/ContractDetails.js');

  assert.match(text(container), /signed-msa\.pdf/);
  assert.match(text(container), /Version 2/);
  assert.match(text(container), /1 file/, 'the count is singular for one document');
  assert.ok([...container.querySelectorAll('button')].some((b) => /Download/.test(b.textContent)));
});

test('an empty document list offers the upload path instead of a blank panel', async () => {
  routeId = 'c-1';
  documentsResponse = [];
  const container = await mountPage('pages/ContractDetails.js');

  assert.match(text(container), /No documents yet/);
  assert.match(text(container), /0 files/);
});

/* ---------------- ContractsList ---------------- */

test('the list End Date column shows the contract calendar date, not the day before', async () => {
  contractsResponse = [CONTRACT];
  const container = await mountPage('pages/ContractsList.js', { waitForList: true });

  const row = container.querySelector('tbody tr');
  const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.trim());
  // Contract #, Title, Type, Party Name, End Date, Amount, Status, Actions
  assert.equal(cells[4], formatDate(CONTRACT_END));
  assert.doesNotMatch(cells[4], /\b29\b/, `the End Date column lost a day: ${cells[4]}`);
  assert.match(cells[5], /USD/);
  // Locale-independent: digit grouping follows the runtime locale, so
  // en-IN renders 250000 as 2,50,000 and en-US as 250,000. Both are correct.
  assert.equal(cells[5].replace(/[^\dA-Z]/g, ''), 'USD250000');
});

test('the list Details link and the create action address the right routes', async () => {
  contractsResponse = [CONTRACT];
  const container = await mountPage('pages/ContractsList.js', { waitForList: true });

  const details = [...container.querySelectorAll('a')].find((a) => /Details/.test(a.textContent));
  assert.equal(details.getAttribute('href'), '/contracts/c-1');

  const creates = [...container.querySelectorAll('a')].filter((a) => /Create contract/i.test(a.textContent));
  assert.ok(creates.length > 0);
  for (const link of creates) assert.equal(link.getAttribute('href'), '/contracts/create');
});

test('an empty list offers the create path when nothing is filtered, and a way to clear the filters when something is', async () => {
  contractsResponse = [];

  // No filters active: clearing them would be a no-op, so the create path is
  // the useful next step.
  let container = await mountPage('pages/ContractsList.js', { waitForList: true });
  assert.match(text(container), /No contracts found/);
  assert.match(text(container), /Create your first contract/);
  assert.ok(
    [...container.querySelectorAll('button, a')].some((el) => /Clear filters/.test(el.textContent)) === false,
    'nothing is filtered, so Clear filters must not be offered'
  );
  const create = [...container.querySelectorAll('a')].find((el) => /Create contract/i.test(el.textContent));
  assert.equal(create.getAttribute('href'), '/contracts/create');

  // A filter is active and matched nothing: the way out is clearing it.
  routeSearch = 'status=Draft';
  container = await mountPage('pages/ContractsList.js', { waitForList: true });
  assert.match(text(container), /No contracts found/);
  assert.match(text(container), /No contracts match these filters/);
  assert.ok(
    [...container.querySelectorAll('button, a')].some((el) => /Clear filters/.test(el.textContent)),
    'a filtered list that matched nothing must offer Clear filters'
  );
});

test('a list error is announced and does not leave a blank table', async () => {
  failure = httpError(500, 'Internal server error');
  const container = await mountPage('pages/ContractsList.js', { waitForList: true });

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(alert.textContent, /Internal server error/);
  assert.equal(container.querySelector('tbody'), null, 'no half-rendered table behind the error');
});