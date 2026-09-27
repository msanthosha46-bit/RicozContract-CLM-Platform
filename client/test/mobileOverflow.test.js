'use strict';

// Regression guard for the mobile overflow of the floating overlays.
//
// The notification popup used a fixed `w-80` (320px) and the toast a fixed
// `max-w-sm` (384px), both anchored to the right edge of a padded container.
// On a 320px phone the popup's left edge sat at -16px and the toast's at -84px,
// which pushed a horizontal scrollbar into the layout and clipped the popup's
// heading and close area.
//
// This repository has no browser test runner, so the geometry is verified
// arithmetically: the className strings are read from the components, the
// Tailwind arbitrary values they contain are evaluated at each viewport width,
// and the resulting box has to stay inside the safe margin on both edges.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src');

const ROOT_FONT_SIZE = 16;
// Tailwind's default spacing scale is 0.25rem per step: px-4 is 16px.
const SPACING_STEP = 4;
// Gap the overlays must keep from both screen edges.
const SAFE_MARGIN = 16;
// Widths the bug was reported on, plus the common widths either side.
const VIEWPORTS = [320, 360, 375, 390, 414, 430, 640, 768, 1024];
const REPORTED_WIDTHS = [320, 375, 390, 430];
// Tailwind's default min-width breakpoints.
const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 };

const topbarSource = fs.readFileSync(path.join(SRC, 'components/Layout/Topbar.js'), 'utf8');
const toastSource = fs.readFileSync(path.join(SRC, 'components/Layout/Common/Toast.js'), 'utf8');

// Evaluates the CSS subset Tailwind arbitrary values use: rem/vw/px units,
// min()/max() and calc(). Underscores stand in for spaces.
const evaluateCss = (source, viewportWidth) => {
  const expression = source.replace(/_/g, ' ').trim();
  assert.match(expression, /^[0-9a-z.,()+\-*/ ]+$/, `unsupported expression: ${source}`);
  const pixels = expression.replace(/(\d*\.?\d+)(rem|vw|px)\b/g, (match, value, unit) => {
    if (unit === 'rem') return String(parseFloat(value) * ROOT_FONT_SIZE);
    if (unit === 'vw') return String((parseFloat(value) * viewportWidth) / 100);
    return String(parseFloat(value));
  });
  // calc() is plain arithmetic; min()/max() map onto their Math counterparts.
  const js = pixels.replace(/\bcalc\(/g, '(').replace(/\bmin\(/g, 'Math.min(').replace(/\bmax\(/g, 'Math.max(');
  return Function(`"use strict"; return (${js});`)();
};

// Reads one utility out of a className and returns its pixel value.
const utility = (className, prefix, viewportWidth) => {
  const arbitrary = className.match(new RegExp(`(?:^|\\s)${prefix}-\\[([^\\]]+)\\]`));
  if (arbitrary) return evaluateCss(arbitrary[1], viewportWidth);
  const scale = className.match(new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)`));
  assert.ok(scale, `no "${prefix}-*" utility in: ${className}`);
  return parseFloat(scale[1]) * SPACING_STEP;
};

// The narrowest utility that still applies at this width, so `sm:px-5` wins at
// 640px and `px-4` is used everywhere below it.
const responsiveUtility = (className, prefix, viewportWidth) => {
  let value = null;
  for (const [variant, minWidth] of Object.entries(BREAKPOINTS)) {
    if (viewportWidth < minWidth) continue;
    const match = className.match(new RegExp(`(?:^|\\s)${variant}:${prefix}-(\\d+(?:\\.\\d+)?)`));
    if (match) value = parseFloat(match[1]) * SPACING_STEP;
  }
  return value === null ? utility(className, prefix, viewportWidth) : value;
};

// Pulls the className off the element tagged with data-overlay="<name>". The
// nearest className attribute wins, so a following sibling's classes are never
// mistaken for the overlay's own.
const overlayClassName = (source, name) => {
  const anchor = source.indexOf(`data-overlay="${name}"`);
  assert.notEqual(anchor, -1, `no data-overlay="${name}" in the component`);
  const rest = source.slice(anchor);
  const quotedAt = rest.indexOf('className="');
  const templatedAt = rest.indexOf('className={`');
  const templated = templatedAt !== -1 && (quotedAt === -1 || templatedAt < quotedAt);
  if (templated) {
    // A template literal, e.g. className={`base ${styles[type]}`}: only the
    // static prefix carries positioning utilities.
    const match = rest.match(/className=\{`([\s\S]*?)\$\{/);
    assert.ok(match, `no template className after data-overlay="${name}"`);
    return match[1].trim();
  }
  const match = rest.match(/className="([^"]*)"/);
  assert.ok(match, `no className after data-overlay="${name}"`);
  return match[1];
};

const headerClassName = (source) => {
  const anchor = source.indexOf('<header');
  assert.notEqual(anchor, -1, 'no <header> in Topbar');
  const match = source.slice(anchor).match(/className="([^"]*)"/);
  assert.ok(match, 'no className on the topbar <header>');
  return match[1];
};

// The popup is `right-0` inside a header with responsive horizontal padding,
// so its right edge is the content edge and its left edge is whatever is left
// after the clamped width.
const popupBox = (viewportWidth) => {
  const className = overlayClassName(topbarSource, 'notifications');
  const padding = responsiveUtility(headerClassName(topbarSource), 'px', viewportWidth);
  const width = utility(className, 'w', viewportWidth);
  const rightEdge = viewportWidth - padding;
  return { width, right: rightEdge, left: rightEdge - width };
};

// The toast is shrink-to-fit (`width: auto`) with `right-4`, so its widest
// possible box is capped by the viewport, and the reported width is that cap.
const toastBox = (viewportWidth) => {
  const className = overlayClassName(toastSource, 'toast');
  const right = utility(className, 'right', viewportWidth);
  const width = Math.min(utility(className, 'max-w', viewportWidth), viewportWidth - right);
  return { width, right: viewportWidth - right, left: viewportWidth - right - width };
};

const assertContained = (label, box, viewportWidth) => {
  assert.ok(box.width > 0 && box.width <= viewportWidth, `${label} is ${box.width}px wide at ${viewportWidth}px`);
  assert.ok(
    box.left >= SAFE_MARGIN,
    `${label} starts at ${box.left}px, past the ${SAFE_MARGIN}px safe margin at ${viewportWidth}px`
  );
  assert.ok(
    box.right <= viewportWidth - SAFE_MARGIN,
    `${label} ends at ${box.right}px, past the ${SAFE_MARGIN}px safe margin at ${viewportWidth}px`
  );
};

test('the popup hangs below the bell and stacks above the page content', () => {
  const className = overlayClassName(topbarSource, 'notifications');
  assert.match(className, /(?:^|\s)absolute(?:\s|$)/);
  assert.match(className, /(?:^|\s)right-0(?:\s|$)/);
  assert.match(className, /(?:^|\s)mt-2(?:\s|$)/);
  assert.match(className, /(?:^|\s)z-50(?:\s|$)/);
});

test('the header still stacks its own sticky layer under the popup', () => {
  assert.match(headerClassName(topbarSource), /(?:^|\s)sticky(?:\s|$)/);
  assert.match(headerClassName(topbarSource), /(?:^|\s)z-20(?:\s|$)/);
});

for (const viewportWidth of VIEWPORTS) {
  test(`the popup fits a ${viewportWidth}px viewport`, () => {
    assertContained('the popup', popupBox(viewportWidth), viewportWidth);
  });

  test(`the toast fits a ${viewportWidth}px viewport`, () => {
    assertContained('the toast', toastBox(viewportWidth), viewportWidth);
  });
}

test('the measurements at the reported widths', (t) => {
  for (const viewportWidth of REPORTED_WIDTHS) {
    const popup = popupBox(viewportWidth);
    const toast = toastBox(viewportWidth);
    t.diagnostic(
      [
        `${viewportWidth}px`.padStart(7),
        `popup  left ${String(popup.left).padStart(3)}px  right ${String(popup.right).padStart(4)}px  width ${String(popup.width).padStart(3)}px`,
        `toast  left ${String(toast.left).padStart(3)}px  right ${String(toast.right).padStart(4)}px  width <= ${String(toast.width).padStart(3)}px`
      ].join('   ')
    );
  }
});

test('the harness would still catch the pre-fix geometry', () => {
  const viewportWidth = 320;
  // w-80 is 320px inside a px-4 header; max-w-sm is 384px inside right-5.
  assert.ok(viewportWidth - 16 - 320 < 0, 'expected the old popup to overflow');
  assert.ok(viewportWidth - 20 - 384 < 0, 'expected the old toast to overflow');
  assert.ok(popupBox(viewportWidth).left >= 0, 'the current popup must not overflow');
  assert.ok(toastBox(viewportWidth).left >= 0, 'the current toast must not overflow');
});
