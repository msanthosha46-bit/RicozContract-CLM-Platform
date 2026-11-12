'use strict';

const fs = require('fs');
const path = require('path');
const routeMetadata = require('../src/seo/routeMetadata.json');

const EXPECTED_ROUTES = ['/', '/login', '/register', '/forgot-password', '/reset-password'];
const NOT_FOUND_METADATA = {
  title: 'Page Not Found – RicozContract',
  description: 'The requested RicozContract page could not be found.',
  robots: 'noindex, nofollow',
  openGraph: {
    'og:type': 'website',
    'og:site_name': 'RicozContract',
    'og:title': 'Page Not Found – RicozContract',
    'og:description': 'The requested RicozContract page could not be found.'
  },
  twitter: {
    'twitter:card': 'summary',
    'twitter:title': 'Page Not Found – RicozContract',
    'twitter:description': 'The requested RicozContract page could not be found.'
  }
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tagsForAttribute = (html, tagName, attribute, value) => {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const keyPattern = new RegExp(`\\s${escapeRegExp(attribute)}\\s*=\\s*(["'])${escapeRegExp(value)}\\1`, 'i');
  return html.match(tagPattern)?.filter((tag) => keyPattern.test(tag)) || [];
};

const updateMeta = (html, attribute, name, content) => {
  const matches = tagsForAttribute(html, 'meta', attribute, name);
  if (matches.length > 1) {
    throw new Error(`Expected at most one meta tag for ${name}; found ${matches.length}`);
  }

  const tag = matches[0]
    ? matches[0].replace(/\scontent\s*=\s*(["'])[\s\S]*?\1/i, () => ` content="${escapeHtml(content)}"`)
    : `<meta ${attribute}="${escapeHtml(name)}" content="${escapeHtml(content)}"/>`;

  if (!matches[0]) {
    return html.replace(/<\/head>/i, () => `${tag}</head>`);
  }
  return html.replace(matches[0], () => tag);
};

const removeMeta = (html, attribute, name) => {
  const matches = tagsForAttribute(html, 'meta', attribute, name);
  if (matches.length > 1) {
    throw new Error(`Expected at most one meta tag for ${name}; found ${matches.length}`);
  }
  return matches.length ? html.replace(matches[0], () => '') : html;
};

const updateTitle = (html, title) => {
  const titlePattern = /<title\b[^>]*>[\s\S]*?<\/title>/gi;
  const matches = html.match(titlePattern) || [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one title tag; found ${matches.length}`);
  }
  return html.replace(titlePattern, () => `<title>${escapeHtml(title)}</title>`);
};

const updateCanonical = (html, canonical) => {
  const linkPattern = /<link\b[^>]*>/gi;
  const matches = (html.match(linkPattern) || []).filter((tag) =>
    /\srel\s*=\s*(["'])canonical\1/i.test(tag)
  );
  if (matches.length > 1) {
    throw new Error(`Expected at most one canonical link; found ${matches.length}`);
  }
  if (!canonical) {
    return matches.length ? html.replace(matches[0], '') : html;
  }
  if (!matches.length) {
    return html.replace(
      /<\/head>/i,
      () => `<link rel="canonical" href="${escapeHtml(canonical)}"/></head>`
    );
  }
  const updated = matches[0].replace(
    /\shref\s*=\s*(["'])[\s\S]*?\1/i,
    () => ` href="${escapeHtml(canonical)}"`
  );
  return html.replace(matches[0], () => updated);
};

const updateStructuredData = (html, structuredData) => {
  const scriptPattern = /<script\b(?=[^>]*\sid=["']ricoz-page-structured-data["'])[^>]*>[\s\S]*?<\/script>/gi;
  const matches = html.match(scriptPattern) || [];
  if (matches.length > 1) {
    throw new Error(`Expected at most one homepage JSON-LD script; found ${matches.length}`);
  }
  let output = matches.length ? html.replace(matches[0], '') : html;
  if (!structuredData) return output;

  const json = JSON.stringify(structuredData).replace(/</g, '\\u003c');
  return output.replace(
    /<\/head>/i,
    () => `<script id="ricoz-page-structured-data" type="application/ld+json">${json}</script></head>`
  );
};

const renderRouteHtml = (template, metadata) => {
  if (!/<\/head>/i.test(template)) {
    throw new Error('Expected the generated HTML to contain a closing head tag');
  }

  let html = updateTitle(template, metadata.title);
  html = updateMeta(html, 'name', 'description', metadata.description);
  html = updateMeta(html, 'name', 'robots', metadata.robots);
  html = updateCanonical(html, metadata.canonical);

  for (const [name, content] of Object.entries(metadata.openGraph)) {
    html = updateMeta(html, 'property', name, content);
  }
  for (const [name, content] of Object.entries(metadata.twitter)) {
    html = updateMeta(html, 'name', name, content);
  }

  html = updateStructuredData(html, metadata.structuredData);

  const rootMatch = html.match(/<div\b(?=[^>]*\sid=["']root["'])[^>]*>([\s\S]*?)<\/div>/i);
  if (!rootMatch || rootMatch[1].trim()) {
    throw new Error('Expected the generated HTML to contain an empty React root');
  }
  return html;
};

const routeOutputPath = (buildDirectory, route) => {
  if (!EXPECTED_ROUTES.includes(route)) {
    throw new Error(`Refusing to generate an unapproved route: ${route}`);
  }
  return route === '/'
    ? path.join(buildDirectory, 'index.html')
    : path.join(buildDirectory, route.slice(1), 'index.html');
};

const generateRouteHtml = (buildDirectory = path.resolve(__dirname, '..', 'build')) => {
  const routes = Object.keys(routeMetadata);
  if (
    routes.length !== EXPECTED_ROUTES.length ||
    EXPECTED_ROUTES.some((route) => !Object.prototype.hasOwnProperty.call(routeMetadata, route))
  ) {
    throw new Error(`SEO route metadata must define exactly: ${EXPECTED_ROUTES.join(', ')}`);
  }

  const templatePath = path.join(buildDirectory, 'index.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  for (const route of EXPECTED_ROUTES) {
    const outputPath = routeOutputPath(buildDirectory, route);
    const html = renderRouteHtml(template, routeMetadata[route]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');
    console.log(`Generated ${path.relative(buildDirectory, outputPath)}`);
  }

  let notFoundHtml = renderRouteHtml(template, NOT_FOUND_METADATA);
  notFoundHtml = removeMeta(notFoundHtml, 'property', 'og:url');
  fs.writeFileSync(path.join(buildDirectory, '404.html'), notFoundHtml, 'utf8');
  console.log('Generated 404.html');
};

if (require.main === module) {
  generateRouteHtml();
}

module.exports = { generateRouteHtml, renderRouteHtml, routeOutputPath };
