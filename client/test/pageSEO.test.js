'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const test = require('node:test');
const { updateStructuredData } = require('../src/seo/updateStructuredData');
const routeMetadata = require('../src/seo/routeMetadata.json');

const clientDirectory = path.join(__dirname, '..');
const sourceDirectory = path.join(clientDirectory, 'src');
const componentDom = new JSDOM(
  '<!doctype html><html><head></head><body></body></html>',
  { url: 'https://example.test/' }
);
const expose = (name, value) => Object.defineProperty(globalThis, name, {
  configurable: true,
  writable: true,
  value
});

for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'MutationObserver',
  'localStorage'
]) {
  expose(name, componentDom.window[name]);
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const babel = require('@babel/core');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const originalJavaScriptLoader = require.extensions['.js'];
require.extensions['.js'] = (module, filename) => {
  if (!filename.startsWith(sourceDirectory + path.sep)) {
    return originalJavaScriptLoader(module, filename);
  }
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
const PageSEO = require('../src/components/PageSEO').default;
const NotFound = require('../src/pages/NotFound').default;
require.extensions['.js'] = originalJavaScriptLoader;

const renderPageSEO = (root, metadata) => act(async () => {
  root.render(React.createElement(PageSEO, metadata));
});

test('preserves Page B JSON-LD when Page A cleanup runs after navigation', () => {
  const dom = new JSDOM('<!doctype html><head></head>');
  const { head } = dom.window.document;
  const pageAData = routeMetadata['/'].structuredData;
  const pageBData = { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Page B' };
  const cleanupPageA = updateStructuredData(pageAData, head);
  const script = head.querySelector('#ricoz-page-structured-data');

  assert.equal(head.querySelectorAll('#ricoz-page-structured-data').length, 1);
  assert.deepEqual(
    JSON.parse(script.textContent),
    pageAData
  );

  const cleanupPageB = updateStructuredData(pageBData, head);
  cleanupPageA();

  assert.equal(head.querySelector('#ricoz-page-structured-data'), script);
  assert.deepEqual(JSON.parse(script.textContent), pageBData);

  cleanupPageB();
  assert.equal(head.querySelector('#ricoz-page-structured-data'), null);
  dom.window.close();
});

test('removes stale JSON-LD when entering a route without structured data', () => {
  const dom = new JSDOM(
    '<!doctype html><head><script id="ricoz-page-structured-data" type="application/ld+json">{}</script></head>'
  );
  const { head } = dom.window.document;

  const cleanupPageA = updateStructuredData({ '@type': 'WebPage', name: 'Page A' }, head);
  updateStructuredData(undefined, head);
  cleanupPageA();
  assert.equal(head.querySelectorAll('#ricoz-page-structured-data').length, 0);

  dom.window.close();
});

test('component cleanup removes its current structured data on unmount', () => {
  const dom = new JSDOM('<!doctype html><head></head>');
  const { head } = dom.window.document;
  const cleanup = updateStructuredData(routeMetadata['/'].structuredData, head);

  cleanup();

  assert.equal(head.querySelector('#ricoz-page-structured-data'), null);
  dom.window.close();
});

test('preserves JSON-LD serialization and escapes less-than characters', () => {
  const dom = new JSDOM('<!doctype html><head></head>');
  const { head } = dom.window.document;
  const structuredData = { '@type': 'Thing', name: '</script><script>alert(1)</script>' };

  updateStructuredData(structuredData, head);

  const script = head.querySelector('#ricoz-page-structured-data');
  assert.equal(script.id, 'ricoz-page-structured-data');
  assert.equal(script.textContent, JSON.stringify(structuredData).replace(/</g, '\\u003c'));
  dom.window.close();
});

test('PageSEO updates route metadata and restores the original head on unmount', async () => {
  const { document } = componentDom.window;
  document.head.innerHTML = `
    <title>Original title</title>
    <meta name="description" content="Original description"/>
    <meta name="robots" content="original robots"/>
    <link rel="canonical" href="https://original.example/"/>
    <meta property="og:title" content="Original Open Graph title"/>
    <meta name="twitter:title" content="Original Twitter title"/>
  `;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await renderPageSEO(root, routeMetadata['/']);
  assert.equal(document.title, routeMetadata['/'].title);
  assert.equal(document.head.querySelector('meta[name="description"]').content, routeMetadata['/'].description);
  assert.equal(document.head.querySelector('meta[name="robots"]').content, 'index, follow');
  assert.equal(document.head.querySelector('link[rel="canonical"]').href, routeMetadata['/'].canonical);
  assert.equal(document.head.querySelector('meta[property="og:title"]').content, routeMetadata['/'].openGraph['og:title']);
  assert.equal(document.head.querySelector('meta[name="twitter:title"]').content, routeMetadata['/'].twitter['twitter:title']);
  assert.deepEqual(
    JSON.parse(document.head.querySelector('#ricoz-page-structured-data').textContent),
    routeMetadata['/'].structuredData
  );

  await renderPageSEO(root, routeMetadata['/login']);
  assert.equal(document.title, routeMetadata['/login'].title);
  assert.equal(document.head.querySelector('meta[name="description"]').content, routeMetadata['/login'].description);
  assert.equal(document.head.querySelector('meta[name="robots"]').content, 'noindex, nofollow');
  assert.equal(document.head.querySelector('link[rel="canonical"]'), null);
  assert.equal(document.head.querySelector('meta[property="og:title"]').content, routeMetadata['/login'].openGraph['og:title']);
  assert.equal(document.head.querySelector('meta[name="twitter:title"]').content, routeMetadata['/login'].twitter['twitter:title']);
  assert.equal(document.head.querySelector('#ricoz-page-structured-data'), null);

  await act(async () => root.unmount());
  assert.equal(document.title, 'Original title');
  assert.equal(document.head.querySelector('meta[name="description"]').content, 'Original description');
  assert.equal(document.head.querySelector('meta[name="robots"]').content, 'original robots');
  assert.equal(document.head.querySelector('link[rel="canonical"]').href, 'https://original.example/');
  assert.equal(document.head.querySelector('meta[property="og:title"]').content, 'Original Open Graph title');
  assert.equal(document.head.querySelector('meta[name="twitter:title"]').content, 'Original Twitter title');
  assert.equal(document.head.querySelector('#ricoz-page-structured-data'), null);

  container.remove();
});

test('protected route metadata is noindex and crawler files list only public content', () => {
  for (const route of ['/login', '/register', '/forgot-password', '/reset-password']) {
    assert.equal(routeMetadata[route].robots, 'noindex, nofollow');
  }

  const publicDirectory = path.join(clientDirectory, 'public');
  const robots = fs.readFileSync(path.join(publicDirectory, 'robots.txt'), 'utf8');
  const sitemap = fs.readFileSync(path.join(publicDirectory, 'sitemap.xml'), 'utf8');
  const llms = fs.readFileSync(path.join(publicDirectory, 'llms.txt'), 'utf8');

  assert.match(robots, /^User-agent: \*\s+Allow: \/\s+Sitemap: https:\/\/ricoz-contract-clm-platform\.vercel\.app\/sitemap\.xml\s*$/);
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.deepEqual(
    Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]),
    [routeMetadata['/'].canonical]
  );
  assert.match(llms, /^# RicozContract/m);
  assert.match(llms, /^## About/m);
  assert.match(llms, /^## Public pages/m);
  assert.ok(llms.includes('contracts, approvals, obligations, documents, milestones, renewals and reports'));
  assert.ok(llms.includes(`- [Home](${routeMetadata['/'].canonical})`));
  assert.doesNotMatch(llms, /\/(login|register|forgot-password|reset-password)\b/);
});

test('the custom not-found page renders and remains noindex', async () => {
  const { document } = componentDom.window;
  document.head.innerHTML = '<title>Original title</title><meta name="robots" content="index, follow"/>';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(NotFound)));
  });

  assert.match(container.textContent, /Error 404/);
  assert.match(container.textContent, /Page not found/);
  assert.equal(document.title, 'Page Not Found – RicozContract');
  assert.equal(document.head.querySelector('meta[name="robots"]').content, 'noindex, nofollow');

  await act(async () => root.unmount());
  assert.equal(document.title, 'Original title');
  assert.equal(document.head.querySelector('meta[name="robots"]').content, 'index, follow');
  container.remove();
});
