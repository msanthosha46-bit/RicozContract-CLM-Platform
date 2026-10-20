'use strict';

// Behaviour tests for the two shared controls that stop a request firing twice
// and stop a widget forcing the page sideways:
//
//  - SubmitButton, which every form routes its submit through, owns the busy
//    state: it disables itself, announces aria-busy, and swaps the label while
//    the request is in flight.
//  - GoogleSignInButton, which used to render Google's iframe at a hard-coded
//    360px. On a 320px phone that iframe was wider than its column and forced a
//    horizontal scrollbar; it now clamps to the container and follows the
//    theme.
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
  'MutationObserver',
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
const SubmitButton = require('../src/components/Layout/Common/SubmitButton').default;
const GoogleSignInButton = require('../src/components/GoogleSignInButton').default;

const mounted = [];

const render = async (element) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
};

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const text = (element) => element.textContent;

test.beforeEach(() => {
  duringGoogleRender = null;
  dom.window.document.body.innerHTML = '';
  dom.window.document.querySelectorAll('script[data-google-identity]').forEach((node) => node.remove());
  delete dom.window.google;
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  dom.window.document.body.innerHTML = '';
  dom.window.document.querySelectorAll('script[data-google-identity]').forEach((node) => node.remove());
  delete dom.window.google;
});

/* ------------------------------------------------------------------ *
 * SubmitButton
 * ------------------------------------------------------------------ */

test('a resting submit button is enabled and unlabelled as busy', async () => {
  const container = await render(React.createElement(SubmitButton, null, 'Save draft'));
  const button = container.querySelector('button');

  assert.equal(button.getAttribute('type'), 'submit');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(text(button), 'Save draft');
});

test('a busy submit button disables itself, announces itself and swaps the label', async () => {
  const container = await render(
    React.createElement(SubmitButton, { loading: true, loadingLabel: 'Saving…' }, 'Save draft')
  );
  const button = container.querySelector('button');

  assert.equal(button.disabled, true, 'a second tap must not reach the handler');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(text(button), 'Saving…');
});

test('a busy submit button without a loading label keeps its own label', async () => {
  // Keeping the text mounted stops the button collapsing and shifting the
  // layout while the request is in flight.
  const container = await render(React.createElement(SubmitButton, { loading: true }, 'Save draft'));

  assert.equal(text(container.querySelector('button')), 'Save draft');
});

test('an explicit disabled prop blocks submit even when not loading', async () => {
  const container = await render(React.createElement(SubmitButton, { disabled: true }, 'Save draft'));
  const button = container.querySelector('button');

  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), null);
});

test('the button is a no-op for clicks while busy', async () => {
  let submits = 0;
  const container = await render(
    React.createElement(
      'form',
      {
        onSubmit: (event) => {
          event.preventDefault();
          submits += 1;
        }
      },
      React.createElement(SubmitButton, { loading: true }, 'Save draft')
    )
  );

  await click(container.querySelector('button'));
  assert.equal(submits, 0);
});

/* ------------------------------------------------------------------ *
 * GoogleSignInButton
 *
 * Two jsdom gaps to bridge. jsdom has no layout, so `clientWidth` is stubbed on
 * the prototype to return whatever viewport width the test is simulating. And
 * jsdom never fetches https://accounts.google.com/gsi/client, so the component
 * would wait forever for that script's `load` event: a `data-google-identity`
 * script tag is planted first, which puts the component on the "script already
 * present" branch where it renders immediately.
 * ------------------------------------------------------------------ */

let layoutWidth = 0;

Object.defineProperty(dom.window.Element.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return layoutWidth;
  }
});

const googleCalls = [];
let duringGoogleRender = null;

const stubGoogleIdentity = () => {
  googleCalls.length = 0;
  dom.window.google = {
    accounts: {
      id: {
        initialize: (config) => googleCalls.push(['initialize', config]),
        renderButton: (node, options) => {
          googleCalls.push(['renderButton', options, node]);
          const hook = duringGoogleRender;
          duringGoogleRender = null;
          hook?.(options);
        }
      }
    }
  };
  const script = dom.window.document.createElement('script');
  script.dataset.googleIdentity = 'true';
  dom.window.document.head.appendChild(script);
};

const lastRenderOptions = () => {
  const render = googleCalls.filter(([name]) => name === 'renderButton').pop();
  assert.ok(render, 'expected the Google button to be rendered');
  return render[1];
};

const mountGoogleButton = async (width) => {
  layoutWidth = width;
  stubGoogleIdentity();
  return render(React.createElement(GoogleSignInButton, { onCredential() {}, onError() {} }));
};

test('the Google button never renders wider than its column', async () => {
  // 288px is the usable width inside the auth card on a 320px phone.
  await mountGoogleButton(288);

  assert.ok(lastRenderOptions().width <= 288, 'a 360px iframe would force a horizontal scrollbar');
});

test('the Google button still uses the full 360px when there is room', async () => {
  await mountGoogleButton(480);

  assert.equal(lastRenderOptions().width, 360);
});

test('a very narrow column clamps up to the 180px minimum', async () => {
  await mountGoogleButton(120);

  assert.equal(lastRenderOptions().width, 180);
});

test('the Google button picks a palette that reads on the current theme', async () => {
  dom.window.document.documentElement.classList.remove('dark');
  await mountGoogleButton(400);
  assert.equal(lastRenderOptions().theme, 'outline');

  // The component watches the class the theme provider toggles on <html>, so a
  // theme switch re-renders the button without a reload.
  await act(async () => {
    dom.window.document.documentElement.classList.add('dark');
  });

  assert.equal(lastRenderOptions().theme, 'filled_black');
  assert.equal(googleCalls.filter(([name]) => name === 'initialize').length, 1);

  await act(async () => dom.window.document.documentElement.classList.remove('dark'));
});

test('a stale credential arriving synchronously during generation rotation is ignored', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const credentials = [];
  await render(React.createElement(GoogleSignInButton, {
    onCredential: (credential) => credentials.push(credential),
    onError() {}
  }));
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const firstButton = lastRenderOptions();

  await act(async () => firstButton.click_listener());
  duringGoogleRender = () => initialize.callback({ credential: 'stale-during-render', state: firstButton.state });
  await act(async () => initialize.callback({ credential: 'accepted', state: firstButton.state }));
  assert.deepEqual(credentials, ['accepted'], 'the old state is invalidated before rendering the retry button');
  assert.notEqual(lastRenderOptions().state, firstButton.state);
});

test('resize and theme changes re-render without initializing Google again', async () => {
  await mountGoogleButton(300);
  const initialGeneration = lastRenderOptions().state;
  const before = googleCalls.filter(([name]) => name === 'renderButton').length;

  layoutWidth = 240;
  const originalSetTimeout = dom.window.setTimeout;
  let debouncedResize;
  dom.window.setTimeout = (callback) => {
    debouncedResize = callback;
    return 1;
  };
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event('resize'));
  });
  await act(async () => debouncedResize());
  dom.window.setTimeout = originalSetTimeout;
  await act(async () => {
    dom.window.document.documentElement.classList.toggle('dark');
  });

  assert.equal(googleCalls.filter(([name]) => name === 'initialize').length, 1);
  assert.ok(googleCalls.filter(([name]) => name === 'renderButton').length > before);
  assert.equal(lastRenderOptions().width, 240);
  assert.notEqual(lastRenderOptions().state, initialGeneration, 'each replacement button receives a fresh GIS state');
});

test('the initialized callback uses the latest credential and error handlers', async () => {
  const credentialCalls = [];
  const errorCalls = [];
  stubGoogleIdentity();
  const container = await render(React.createElement(GoogleSignInButton, {
    onCredential: () => credentialCalls.push('old'),
    onError: (error) => errorCalls.push(error)
  }));
  const root = mounted[mounted.length - 1];
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const buttonOptions = lastRenderOptions();

  await act(async () => {
    root.render(React.createElement(GoogleSignInButton, {
      onCredential: (credential) => {
        credentialCalls.push('new');
        if (credential === 'throws') throw new Error('credential handler failed');
      },
      onError: (error) => errorCalls.push(error)
    }));
  });
  await act(async () => buttonOptions.click_listener());
  await act(async () => initialize.callback({ credential: 'test-credential', state: buttonOptions.state }));
  const retryButton = lastRenderOptions();
  assert.notEqual(retryButton.state, buttonOptions.state, 'a retry uses a fresh GIS button generation');
  await act(async () => retryButton.click_listener());
  await act(async () => initialize.callback({ credential: 'throws', state: retryButton.state }));

  assert.deepEqual(credentialCalls, ['new', 'new']);
  assert.equal(errorCalls.length, 1);
  assert.equal(errorCalls[0].message, 'credential handler failed');
  assert.equal(container.querySelector('[aria-busy]').getAttribute('aria-busy'), 'false');
});

test('multiple button instances share one Google initialization', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const container = await render(React.createElement(React.Fragment, null,
    React.createElement(GoogleSignInButton, { onCredential() {}, onError() {} }),
    React.createElement(GoogleSignInButton, { onCredential() {}, onError() {} })
  ));

  assert.equal(googleCalls.filter(([name]) => name === 'initialize').length, 1);
  assert.equal(googleCalls.filter(([name]) => name === 'renderButton').length, 2);
  assert.equal(container.querySelectorAll('[aria-busy]').length, 2);
});

test('two mounted buttons route credentials and errors only to the clicked button', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const calls = [
    { credentials: [], errors: [] },
    { credentials: [], errors: [] }
  ];
  const button = (index) => React.createElement(GoogleSignInButton, {
    onCredential: (credential) => calls[index].credentials.push(credential),
    onError: (error) => calls[index].errors.push(error.message)
  });
  const container = await render(React.createElement(React.Fragment, null, button(0), button(1)));

  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const rendered = googleCalls.filter(([name]) => name === 'renderButton');
  const firstButton = rendered[0][1];
  const secondButton = rendered[1][1];
  assert.notEqual(firstButton.state, secondButton.state);

  await act(async () => firstButton.click_listener());
  assert.equal(container.querySelectorAll('[aria-busy="true"]').length, 2, 'a sign-in attempt locks every mounted button');
  await act(async () => secondButton.click_listener());
  assert.equal(container.querySelectorAll('[aria-busy="true"]').length, 2, 'a second button cannot start a concurrent attempt');
  await act(async () => initialize.callback({ credential: 'first-credential', state: firstButton.state }));
  assert.deepEqual(calls[0].credentials, ['first-credential']);
  assert.deepEqual(calls[1].credentials, []);
  assert.equal(container.querySelectorAll('[aria-busy="true"]').length, 0, 'success releases the shared pending state');

  await act(async () => secondButton.click_listener());
  await act(async () => initialize.callback({ credential: 'second-credential', state: secondButton.state }));
  assert.deepEqual(calls[1].credentials, ['second-credential']);
  assert.deepEqual(calls[0].errors, []);
  assert.deepEqual(calls[1].errors, []);
  assert.equal(container.querySelectorAll('[aria-busy="true"]').length, 0, 'the terminal credential releases the shared pending state');
});

test('a competing button callback cannot claim or release the active attempt', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const credentials = [[], []];
  await render(React.createElement(React.Fragment, null,
    React.createElement(GoogleSignInButton, { onCredential: (value) => credentials[0].push(value), onError() {} }),
    React.createElement(GoogleSignInButton, { onCredential: (value) => credentials[1].push(value), onError() {} })
  ));
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const options = googleCalls.filter(([name]) => name === 'renderButton').map((entry) => entry[1]);

  await act(async () => options[0].click_listener());
  await act(async () => options[1].click_listener());
  await act(async () => initialize.callback({ credential: 'wrong-owner', state: options[1].state }));
  assert.deepEqual(credentials, [[], []]);
  await act(async () => initialize.callback({ credential: 'active-owner', state: options[0].state }));
  assert.deepEqual(credentials, [['active-owner'], []]);
});

test('duplicate credential callbacks for one generation are consumed only once', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const credentials = [];
  await render(React.createElement(GoogleSignInButton, {
    onCredential: (credential) => credentials.push(credential),
    onError() {}
  }));
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const firstButton = lastRenderOptions();

  await act(async () => firstButton.click_listener());
  await act(async () => initialize.callback({ credential: 'once', state: firstButton.state }));
  const retryButton = lastRenderOptions();
  await act(async () => retryButton.click_listener());
  await act(async () => initialize.callback({ credential: 'duplicate-old', state: firstButton.state }));
  assert.deepEqual(credentials, ['once'], 'a duplicate old-generation credential cannot reach the retry handler');
  await act(async () => initialize.callback({ credential: 'twice', state: retryButton.state }));
  assert.deepEqual(credentials, ['once', 'twice']);
});

test('theme re-renders defer during an attempt, then retire old clicks and credentials', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const credentials = [];
  await render(React.createElement(GoogleSignInButton, {
    onCredential: (credential) => credentials.push(credential),
    onError() {}
  }));
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const originalButton = lastRenderOptions();

  await act(async () => originalButton.click_listener());
  await act(async () => dom.window.document.documentElement.classList.add('dark'));
  assert.equal(lastRenderOptions().state, originalButton.state, 'the active GIS button is retained until its callback settles');
  await act(async () => initialize.callback({ credential: 'active-credential', state: originalButton.state }));
  const replacementButton = lastRenderOptions();
  assert.notEqual(replacementButton.state, originalButton.state, 'the replacement button receives a fresh generation');
  assert.equal(replacementButton.theme, 'filled_black');

  await act(async () => originalButton.click_listener());
  assert.equal(credentials.length, 1, 'the retired click listener cannot start another attempt');
  await act(async () => replacementButton.click_listener());
  await act(async () => initialize.callback({ credential: 'stale-credential', state: originalButton.state }));
  assert.deepEqual(credentials, ['active-credential'], 'a retired generation cannot deliver or release a newer attempt');
  assert.equal(document.querySelector('[aria-busy]').getAttribute('aria-busy'), 'true');
  await act(async () => initialize.callback({ credential: 'replacement-credential', state: replacementButton.state }));
  assert.deepEqual(credentials, ['active-credential', 'replacement-credential']);
  await act(async () => dom.window.document.documentElement.classList.remove('dark'));
});

test('an unmounted button cannot send its pending result to another mounted button', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const firstCalls = { credentials: [], errors: [] };
  const secondCalls = { credentials: [], errors: [] };
  const firstContainer = await render(React.createElement(GoogleSignInButton, {
    onCredential: (credential) => firstCalls.credentials.push(credential),
    onError: (error) => firstCalls.errors.push(error.message)
  }));
  const firstRoot = mounted[mounted.length - 1];
  const secondContainer = await render(React.createElement(GoogleSignInButton, {
    onCredential: (credential) => secondCalls.credentials.push(credential),
    onError: (error) => secondCalls.errors.push(error.message)
  }));
  const secondRoot = mounted[mounted.length - 1];
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const rendered = googleCalls.filter(([name]) => name === 'renderButton');
  const firstButton = rendered[0][1];
  const secondButton = rendered[1][1];

  await act(async () => firstButton.click_listener());
  assert.equal(secondContainer.querySelector('[aria-busy]').getAttribute('aria-busy'), 'true');
  await act(async () => firstRoot.unmount());
  mounted.splice(mounted.indexOf(firstRoot), 1);
  assert.equal(firstContainer.innerHTML, '');
  assert.equal(secondContainer.querySelector('[aria-busy]').getAttribute('aria-busy'), 'true', 'an unmounted owner cannot release an uncorrelated attempt');
  await act(async () => secondButton.click_listener());
  assert.deepEqual(secondCalls.errors, [], 'a new owner cannot start while the abandoned attempt is unresolved');
  await act(async () => initialize.callback({ credential: 'late-credential', state: firstButton.state }));

  assert.deepEqual(firstCalls.credentials, []);
  assert.deepEqual(secondCalls.credentials, []);
  assert.equal(secondContainer.querySelector('[aria-busy]').getAttribute('aria-busy'), 'false', 'the late stateful credential releases the quarantine');
  await act(async () => secondButton.click_listener());
  await act(async () => initialize.callback({ credential: 'second-credential', state: secondButton.state }));
  assert.deepEqual(secondCalls.credentials, ['second-credential']);
  assert.deepEqual(secondCalls.errors, []);

  await act(async () => secondRoot.unmount());
  mounted.splice(mounted.indexOf(secondRoot), 1);
  assert.equal(secondContainer.innerHTML, '');
});

test('a missing GIS callback keeps the coordinator locked and offers an explicit reload', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const errors = [];
  const first = await render(React.createElement(GoogleSignInButton, { onCredential() {}, onError: (error) => errors.push(error.message) }));
  const second = await render(React.createElement(GoogleSignInButton, { onCredential() {}, onError: (error) => errors.push(error.message) }));
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const options = googleCalls.filter(([name]) => name === 'renderButton').map((entry) => entry[1]);

  await act(async () => options[0].click_listener());
  await act(async () => options[1].click_listener());
  assert.equal(first.querySelector('[aria-busy]').getAttribute('aria-busy'), 'true');
  assert.equal(second.querySelector('[aria-busy]').getAttribute('aria-busy'), 'true');
  assert.deepEqual(errors, [], 'no callback means no component is guessed as the error owner');
  assert.ok(first.querySelector('[role="status"]'), 'the pending recovery message is visible');
  assert.equal(first.querySelector('button')?.textContent, 'Reload page');
  assert.equal(initialize.error_callback, undefined, 'the Identity API is not configured with an unsupported error callback');

  // Component-level simulation only: credential delivery releases the lock.
  // The real GIS API may provide no terminal signal when its popup is closed.
  await act(async () => initialize.callback({ credential: 'terminal', state: options[0].state }));
  assert.deepEqual(errors, []);
  assert.equal(first.querySelector('[aria-busy]').getAttribute('aria-busy'), 'false');
  assert.equal(second.querySelector('[aria-busy]').getAttribute('aria-busy'), 'false');
});

test('late credentials with an old state cannot be delivered to a newer attempt', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const seen = [[], []];
  const container = await render(React.createElement(React.Fragment, null,
    React.createElement(GoogleSignInButton, { onCredential: (credential) => seen[0].push(credential), onError() {} }),
    React.createElement(GoogleSignInButton, { onCredential: (credential) => seen[1].push(credential), onError() {} })
  ));
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const options = googleCalls.filter(([name]) => name === 'renderButton').map((entry) => entry[1]);

  await act(async () => options[0].click_listener());
  await act(async () => initialize.callback({ credential: 'first', state: options[0].state }));
  await act(async () => options[1].click_listener());
  await act(async () => initialize.callback({ credential: 'stale-first', state: options[0].state }));
  assert.deepEqual(seen, [['first'], []]);
  await act(async () => initialize.callback({ credential: 'second', state: options[1].state }));
  assert.deepEqual(seen, [['first'], ['second']]);
  assert.equal(container.querySelectorAll('[aria-busy="true"]').length, 0);
});

test('React Strict Mode effect replay does not initialize Google twice', async () => {
  stubGoogleIdentity();
  layoutWidth = 320;
  const credentials = [];
  await render(React.createElement(React.StrictMode, null,
    React.createElement(GoogleSignInButton, {
      onCredential: (credential) => credentials.push(credential),
      onError() {}
    })
  ));

  assert.equal(googleCalls.filter(([name]) => name === 'initialize').length, 1);
  const initialize = googleCalls.find(([name]) => name === 'initialize')[1];
  const generations = googleCalls.filter(([name]) => name === 'renderButton').map((entry) => entry[1]);
  const staleOptions = generations[0];
  const options = generations[generations.length - 1];
  assert.notEqual(staleOptions.state, options.state, 'effect replay receives a fresh button generation');
  await act(async () => options.click_listener());
  await act(async () => initialize.callback({ credential: 'stale-strict', state: staleOptions.state }));
  assert.deepEqual(credentials, [], 'the pre-replay state is rejected while the new attempt is active');
  await act(async () => initialize.callback({ credential: 'strict-credential', state: options.state }));
  assert.deepEqual(credentials, ['strict-credential']);
});

test('a late GIS script load renders once and its listener is removed on unmount', async () => {
  googleCalls.length = 0;
  const script = dom.window.document.createElement('script');
  script.dataset.googleIdentity = 'true';
  dom.window.document.head.appendChild(script);
  layoutWidth = 320;
  const container = await render(React.createElement(GoogleSignInButton, { onCredential() {}, onError() {} }));

  dom.window.google = {
    accounts: { id: {
      initialize: (config) => googleCalls.push(['initialize', config]),
      renderButton: (node, options) => googleCalls.push(['renderButton', options, node])
    } }
  };
  await act(async () => script.dispatchEvent(new dom.window.Event('load')));
  assert.equal(googleCalls.filter(([name]) => name === 'initialize').length, 1);
  assert.equal(googleCalls.filter(([name]) => name === 'renderButton').length, 1);

  const root = mounted[mounted.length - 1];
  await act(async () => root.unmount());
  mounted.pop();
  await act(async () => script.dispatchEvent(new dom.window.Event('load')));
  assert.equal(googleCalls.filter(([name]) => name === 'renderButton').length, 1);
  assert.equal(container.innerHTML, '');
});
