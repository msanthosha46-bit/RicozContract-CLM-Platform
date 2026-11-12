'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const routeMetadata = require('../src/seo/routeMetadata.json');
const { generateRouteHtml, renderRouteHtml, routeOutputPath } = require('../scripts/generate-route-html');

const ROUTES = ['/', '/login', '/register', '/forgot-password', '/reset-password'];
const TEMPLATE = `<!doctype html>
<html lang="en"><head>
<title>Initial title</title>
<meta name="description" content="Initial description"/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="https://ricoz-contract-clm-platform.vercel.app/"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="RicozContract"/>
<meta property="og:title" content="Initial title"/>
<meta property="og:description" content="Initial description"/>
<meta property="og:url" content="https://ricoz-contract-clm-platform.vercel.app/"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="Initial title"/>
<meta name="twitter:description" content="Initial description"/>
</head><body><div id="root"></div><script src="/static/js/main.js"></script></body></html>`;

test('generates only the five configured public route shells with matching metadata', (t) => {
  const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ricoz-seo-build-'));
  t.after(() => fs.rmSync(buildDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(buildDirectory, 'index.html'), TEMPLATE);

  generateRouteHtml(buildDirectory);

  const expectedFiles = ROUTES.map((route) => routeOutputPath(buildDirectory, route));
  expectedFiles.push(path.join(buildDirectory, '404.html'));
  assert.deepEqual(
    fs.readdirSync(buildDirectory, { recursive: true })
      .filter((entry) => entry.endsWith('.html'))
      .sort(),
    [
      '404.html',
      path.join('forgot-password', 'index.html'),
      'index.html',
      path.join('login', 'index.html'),
      path.join('register', 'index.html'),
      path.join('reset-password', 'index.html')
    ].sort()
  );

  for (const route of ROUTES) {
    const html = fs.readFileSync(routeOutputPath(buildDirectory, route), 'utf8');
    const metadata = routeMetadata[route];
    assert.equal((html.match(/<title\b/gi) || []).length, 1);
    assert.match(html, new RegExp(`<title>${metadata.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</title>`));
    assert.equal((html.match(/<meta\s+name="description"/gi) || []).length, 1);
    assert.equal((html.match(/<meta\s+name="robots"/gi) || []).length, 1);
    assert.match(html, new RegExp(`<meta name="robots" content="${metadata.robots}"/>`));
    assert.equal((html.match(/<meta\s+property="og:title"/gi) || []).length, 1);
    assert.equal((html.match(/<meta\s+name="twitter:title"/gi) || []).length, 1);
    assert.match(html, /<div id="root"><\/div>/);
    assert.doesNotMatch(html, /ricoz_user|reset-token|auth-token|secret-token/i);
    assert.doesNotMatch(html, /<form\b/i);

    for (const [name, content] of Object.entries(metadata.openGraph)) {
      assert.match(html, new RegExp(`<meta property="${name}" content="${content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"/>`));
    }
    for (const [name, content] of Object.entries(metadata.twitter)) {
      assert.match(html, new RegExp(`<meta name="${name}" content="${content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"/>`));
    }

    if (metadata.canonical) {
      assert.equal((html.match(/<link\s+rel="canonical"/gi) || []).length, 1);
      assert.match(html, new RegExp(`<link rel="canonical" href="${metadata.canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"/>`));
    } else {
      assert.equal((html.match(/<link\s+rel="canonical"/gi) || []).length, 0);
    }

    const jsonLdScripts = html.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) || [];
    assert.equal(jsonLdScripts.length, metadata.structuredData ? 1 : 0);
    if (metadata.structuredData) {
      assert.deepEqual(JSON.parse(jsonLdScripts[0].replace(/^<script\b[^>]*>|<\/script>$/gi, '')), metadata.structuredData);
    }
  }

  const notFoundHtml = fs.readFileSync(path.join(buildDirectory, '404.html'), 'utf8');
  assert.match(notFoundHtml, /<title>Page Not Found – RicozContract<\/title>/);
  assert.match(notFoundHtml, /<meta name="robots" content="noindex, nofollow"\/>/);
  assert.equal((notFoundHtml.match(/<link\s+rel="canonical"/gi) || []).length, 0);
  assert.equal((notFoundHtml.match(/<meta\s+property="og:url"/gi) || []).length, 0);
  assert.equal((notFoundHtml.match(/<script\b[^>]*type="application\/ld\+json"/gi) || []).length, 0);
  assert.match(notFoundHtml, /<div id="root"><\/div>/);

  assert.equal(expectedFiles.length, ROUTES.length + 1);
  assert.throws(() => routeOutputPath(buildDirectory, '/reset-password?token=private'), /unapproved route/);
  assert.throws(() => routeOutputPath(buildDirectory, '/dashboard'), /unapproved route/);
});

test('escapes dynamic metadata and preserves replacement-token text', () => {
  const metadata = JSON.parse(JSON.stringify(routeMetadata['/']));
  const replacementTokens = ['$&', "$'", '$`', '$1'].join(' ');
  metadata.title = `Offer ${replacementTokens} <terms> & "quoted"`;
  metadata.description = `Details ${replacementTokens} & <terms>`;
  metadata.canonical = `https://example.test/offer/${replacementTokens}`;
  metadata.openGraph['og:title'] = `Social ${replacementTokens} <title>`;
  metadata.twitter['twitter:title'] = `Tweet ${replacementTokens} & <title>`;
  metadata.structuredData.name = `</script>${replacementTokens}`;

  const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = renderRouteHtml(TEMPLATE, metadata);
  const jsonLd = html.match(/<script\b[^>]*id="ricoz-page-structured-data"[^>]*>([\s\S]*?)<\/script>/i);

  assert.ok(html.includes(`<title>${escapeHtml(metadata.title)}</title>`));
  assert.ok(html.includes(`<meta name="description" content="${escapeHtml(metadata.description)}"/>`));
  assert.ok(html.includes(`<link rel="canonical" href="${escapeHtml(metadata.canonical)}"/>`));
  assert.ok(html.includes(`<meta property="og:title" content="${escapeHtml(metadata.openGraph['og:title'])}"/>`));
  assert.ok(html.includes(`<meta name="twitter:title" content="${escapeHtml(metadata.twitter['twitter:title'])}"/>`));
  assert.ok(jsonLd);
  assert.deepEqual(JSON.parse(jsonLd[1]), metadata.structuredData);
  assert.match(html, /<div id="root"><\/div>/);
});

test('rejects templates without a closing head tag', () => {
  const template = '<html><head><title>Initial title</title><body><div id="root"></div></body></html>';

  assert.throws(
    () => renderRouteHtml(template, routeMetadata['/']),
    /closing head tag/
  );
});

test('does not confuse prefixed data attributes with metadata or the React root', () => {
  const metadata = routeMetadata['/'];
  const template = TEMPLATE
    .replace('<meta name="description" content="Initial description"/>', '<meta data-name="description" data-content="Decoy"/>')
    .replace('<link rel="canonical" href="https://ricoz-contract-clm-platform.vercel.app/"/>', '<link data-rel="canonical" data-href="https://example.test/decoy"/>')
    .replace('</head>', '<script data-id="ricoz-page-structured-data" type="text/plain">decoy</script></head>');
  const html = renderRouteHtml(template, metadata);

  assert.match(html, /<meta data-name="description" data-content="Decoy"\/>/);
  assert.match(html, /<meta name="description" content="Manage contracts/);
  assert.match(html, /<link data-rel="canonical" data-href="https:\/\/example\.test\/decoy"\/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ricoz-contract-clm-platform\.vercel\.app\/"\/>/);
  assert.match(html, /<script data-id="ricoz-page-structured-data" type="text\/plain">decoy<\/script>/);
  assert.throws(
    () => renderRouteHtml(TEMPLATE.replace('<div id="root"></div>', '<div data-id="root"></div>'), metadata),
    /empty React root/
  );
});
