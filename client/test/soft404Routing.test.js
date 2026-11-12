'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const clientDirectory = path.join(__dirname, '..');
const repositoryDirectory = path.join(clientDirectory, '..');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repositoryDirectory, 'vercel.json'), 'utf8'));
const appSource = fs.readFileSync(path.join(clientDirectory, 'src', 'App.js'), 'utf8');

const matchesRoute = (source, pathname) => {
  const pattern = source
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${pattern}/?$`).test(pathname);
};

test('preserves API proxy and static SEO rewrites while routing known SPA paths', () => {
  const rewrites = vercelConfig.rewrites;

  assert.deepEqual(rewrites[0], {
    source: '/api/:path*',
    destination: 'https://ricozcontract-clm-platform-2.onrender.com/api/:path*'
  });

  for (const route of ['/login', '/register', '/forgot-password', '/reset-password']) {
    assert.ok(rewrites.some((rewrite) => (
      rewrite.source === route && rewrite.destination === `${route}/index.html`
    )), `missing static SEO shell rewrite for ${route}`);
  }

  const appRoutes = Array.from(appSource.matchAll(/<Route\s+path="([^"]+)"/g), (match) => match[1]);
  const staticShellRoutes = new Set(['/', '/login', '/register', '/forgot-password', '/reset-password']);
  const appRouteRewrites = rewrites.filter((rewrite) => rewrite.destination === '/index.html');

  for (const route of appRoutes.filter((route) => !staticShellRoutes.has(route) && route !== '*')) {
    assert.ok(
      appRouteRewrites.some((rewrite) => rewrite.source === route),
      `missing SPA rewrite for registered route ${route}`
    );
    assert.ok(
      appRouteRewrites.some((rewrite) => matchesRoute(rewrite.source, route.replace(/:[^/]+/g, 'sample-id'))),
      `registered route does not match an index rewrite: ${route}`
    );
  }

  assert.equal(rewrites.some((rewrite) => rewrite.source === '/(.*)'), false);
  for (const pathname of ['/unknown-seo-path', '/contracts/sample-id/unknown', '/dashboard/unknown']) {
    assert.equal(
      appRouteRewrites.some((rewrite) => matchesRoute(rewrite.source, pathname)),
      false,
      `unknown path should fall through to the Vercel 404: ${pathname}`
    );
  }
});
