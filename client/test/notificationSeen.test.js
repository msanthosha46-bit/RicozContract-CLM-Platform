'use strict';

// Phase-9 regression tests for the notification panel:
//
//  - overdue obligations and milestones are separated into their own groups,
//    headings and shortcuts, so a milestone-only feed no longer steers the
//    user to the obligations page;
//  - a failed fetch surfaces an error state with a working Retry instead of
//    being silently swallowed;
//  - the bell announces the unread count and the decorative badge is hidden
//    from assistive tech;
//  - browser-local seen tracking is keyed by stable notification id and scoped
//    per user, opening the panel marks the current feed seen, and anything that
//    arrives afterwards stays unread.
//
// Same zero-install harness as notificationPopup.test.js.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.ricoz.test/' });

const expose = (name, value) => {
  if (value === undefined) return;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

for (const name of [
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage'
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
      [require.resolve('@babel/preset-react'), { runtime: 'automatic' }]
    ]
  });
  return module._compile(code, filename);
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const api = require('../src/services/api').default;
const { AuthContext } = require('../src/context/AuthContext');
const Topbar = require('../src/components/Layout/Topbar').default;
const seenStorageKey = require('../src/utils/notificationSeen').seenStorageKey;
const writeSeenIds = require('../src/utils/notificationSeen').writeSeenIds;
const pruneSeenIds = require('../src/utils/notificationSeen').pruneSeenIds;
const readSeenIds = require('../src/utils/notificationSeen').readSeenIds;

const ADMIN = { _id: 'user-a', email: 'a@ricoz.test', role: 'admin' };

const N1 = { id: 'obligation-o1', type: 'overdue', title: 'Overdue: insurance', detail: 'CNT-1', href: '/obligations' };
const N2 = { id: 'milestone-m1', type: 'overdue', title: 'Overdue: sign-off', detail: 'CNT-2', href: '/milestones' };
const N3 = { id: 'expiring-c1', type: 'expiry', title: 'CNT-3 expires soon', detail: 'Vendor MSA', href: '/contracts/c1' };

const LocationProbe = () => {
  const { pathname } = useLocation();
  return React.createElement('span', { 'data-testid': 'location' }, pathname);
};

const bell = (container) => container.querySelector('button[aria-label^="Notifications"]');
const panel = (container) => container.querySelector('[data-overlay="notifications"]');
const badgeSpans = (container) =>
  [...bell(container).querySelectorAll('span')].filter((node) => /rounded-full/.test(node.className || ''));

const mounted = [];

const unmountAll = async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
};

const renderTopbar = async ({ user = ADMIN, notifications = { count: 1, items: [N1] }, apiGet } = {}) => {
  api.get = apiGet || (async () => ({ data: notifications }));
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/dashboard'] },
        React.createElement(
          AuthContext.Provider,
          { value: { user, logout() {} } },
          React.createElement(React.Fragment, null,
            React.createElement(LocationProbe),
            React.createElement(Topbar, { onMenuClick() {} })
          )
        )
      )
    );
  });
  return container;
};

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

test.beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.document.body.innerHTML = '';
});

test.afterEach(async () => {
  await unmountAll();
  dom.window.document.body.innerHTML = '';
  dom.window.localStorage.clear();
});

test('seenStorageKey exists only when a user id is present', () => {
  assert.equal(seenStorageKey(undefined), null);
  assert.equal(seenStorageKey(''), null);
  assert.equal(seenStorageKey('user-a'), 'ricoz_seen_notifications:user-a');
});

test('pruneSeenIds drops ids that left the feed and persists the survivors', () => {
  const userId = 'prune-user';
  writeSeenIds(userId, ['a', 'b', 'c']);
  const kept = pruneSeenIds(userId, ['a', 'c', 'd']);
  assert.deepEqual(kept, ['a', 'c']);
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(seenStorageKey(userId))), ['a', 'c']);
});

test('readSeenIds tolerates corrupt storage', () => {
  dom.window.localStorage.setItem(seenStorageKey('bad-user'), 'not json');
  assert.deepEqual(readSeenIds('bad-user'), []);
});

test('the badge and the bell label show only the unread notifications', async () => {
  const userId = ADMIN._id;
  writeSeenIds(userId, [N1.id]);
  const container = await renderTopbar({ notifications: { count: 2, items: [N1, N2] } });

  assert.equal(bell(container).getAttribute('aria-label'), 'Notifications: 1 unread');
  assert.equal(badgeSpans(container).length, 1);
  assert.equal(badgeSpans(container)[0].textContent, '1');
});

test('closing the panel marks the current feed seen and clears the badge', async () => {
  const userId = ADMIN._id;
  const container = await renderTopbar({ notifications: { count: 2, items: [N1, N2] } });

  await click(bell(container));
  assert.equal(bell(container).getAttribute('aria-label'), 'Notifications: 2 unread', 'opening alone does not mark anything seen');
  assert.equal(panel(container).querySelectorAll('[data-unread="true"]').length, 2, 'both items stay visually unread while open');

  await click(bell(container));

  assert.ok(!panel(container), 'the panel closed');
  assert.equal(bell(container).getAttribute('aria-label'), 'Notifications');
  assert.equal(badgeSpans(container).length, 0);
  assert.deepEqual(
    new Set(JSON.parse(dom.window.localStorage.getItem(seenStorageKey(userId)))),
    new Set([N1.id, N2.id]),
    'both ids are persisted as seen once the panel is closed'
  );
});

test('a newly arriving notification stays unread after a reload', async () => {
  const userId = ADMIN._id;
  const first = await renderTopbar({ notifications: { count: 2, items: [N1, N2] } });
  await click(bell(first));
  await click(bell(first));
  await unmountAll();
  dom.window.document.body.innerHTML = '';

  const second = await renderTopbar({ notifications: { count: 3, items: [N1, N2, N3] } });

  assert.equal(bell(second).getAttribute('aria-label'), 'Notifications: 1 unread', 'N3 has no seen record');
  await click(bell(second));
  const unreadDots = panel(second).querySelectorAll('[data-unread="true"]');
  assert.equal(unreadDots.length, 1);
  assert.match(panel(second).textContent, /expires soon/);
});

test('seen state is stored and read per user', async () => {
  writeSeenIds('user-a', [N1.id]);
  const makeFeed = () => ({ count: 2, items: [N1, N2] });

  const forA = await renderTopbar({ user: ADMIN, notifications: makeFeed() });
  assert.equal(bell(forA).getAttribute('aria-label'), 'Notifications: 1 unread');

  await unmountAll();
  dom.window.document.body.innerHTML = '';

  const forB = await renderTopbar({
    user: { _id: 'user-b', email: 'b@ricoz.test', role: 'employee' },
    notifications: makeFeed()
  });
  assert.equal(bell(forB).getAttribute('aria-label'), 'Notifications: 2 unread', 'user-b starts unseen');
  assert.deepEqual(
    JSON.parse(dom.window.localStorage.getItem(seenStorageKey('user-b')) || '[]'),
    [],
    "user-b's own key was never written"
  );
});

test('a failed fetch shows an error state whose Retry reloads the feed', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return { data: { count: 1, items: [N1] } };
  };
  const container = await renderTopbar({ apiGet: flaky });

  assert.equal(calls, 1, 'the initial fetch ran once');
  await click(bell(container));
  assert.match(panel(container).textContent, /Could not load notifications/);

  const retry = [...panel(container).querySelectorAll('button')].find((node) => node.textContent.trim() === 'Retry');
  assert.ok(retry, 'a Retry button is offered');

  await click(retry);
  assert.equal(calls, 2);
  assert.match(panel(container).textContent, /Overdue: insurance/);
  assert.doesNotMatch(panel(container).textContent, /Could not load notifications/);
});

test('the bell announces the unread count and hides the decorative badge', async () => {
  const container = await renderTopbar({ notifications: { count: 2, items: [N1, N2] } });

  assert.equal(badgeSpans(container).length, 1);
  assert.equal(badgeSpans(container)[0].getAttribute('aria-hidden'), 'true');
  assert.equal(bell(container).getAttribute('aria-label'), 'Notifications: 2 unread');

  const live = container.querySelector('[aria-live="polite"]');
  assert.ok(live, 'a polite live region exists for announcements');
  assert.equal(live.getAttribute('aria-atomic'), 'true');
});

test('overdue obligations and milestones get separate headings and shortcuts', async () => {
  const container = await renderTopbar({ notifications: { count: 2, items: [N1, N2] } });
  await click(bell(container));

  assert.match(panel(container).textContent, /Overdue obligations/);
  assert.match(panel(container).textContent, /Overdue milestones/);

  const link = (href) => [...panel(container).querySelectorAll('a[href]')].find((node) => node.getAttribute('href') === href);
  assert.ok(link('/obligations'), 'the obligation item links to /obligations');
  assert.ok(link('/milestones'), 'the milestone item links to /milestones');

  const milestoneShortcut = [...panel(container).querySelectorAll('button')].find((node) => node.textContent.trim() === 'Overdue milestones');
  assert.ok(milestoneShortcut, 'a milestone shortcut is rendered');
  await click(milestoneShortcut);
  assert.equal(
    container.querySelector('[data-testid="location"]').textContent,
    '/milestones',
    'the milestone shortcut navigates to /milestones'
  );
});

test('unread items carry a dot until the panel is opened', async () => {
  const userId = ADMIN._id;
  writeSeenIds(userId, [N1.id]);
  const container = await renderTopbar({ notifications: { count: 2, items: [N1, N2] } });
  await click(bell(container));

  const dots = panel(container).querySelectorAll('[data-unread="true"]');
  assert.equal(dots.length, 1, 'only N2 is new');
  assert.equal(dots[0].getAttribute('aria-hidden'), 'true');

  assert.match(panel(container).textContent, /Overdue: insurance/);
  assert.match(panel(container).textContent, /Overdue: sign-off/);
});