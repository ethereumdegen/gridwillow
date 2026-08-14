#!/usr/bin/env node
/**
 * shoot.mjs — the visual test harness.
 *
 *   node scripts/shoot.mjs examples/payments.bp
 *   node scripts/shoot.mjs examples/payments.bp --zoom 0.5,1,2,4 --dpr 1,2
 *   node scripts/shoot.mjs examples/payments.bp --check           # assert, don't just look
 *   node scripts/shoot.mjs examples/payments.bp --focus orders --inspect
 *   node scripts/shoot.mjs examples/payments.bp --mobile --check
 *
 * Renders a blueprint headlessly across zoom levels and device pixel ratios,
 * writes a PNG per combination, and — with --check — measures whether every
 * label is actually where it should be.
 *
 * The alignment check is the point. It projects each block's apex itself, using
 * the canvas element's real on-screen rectangle, and compares that against where
 * the label div actually ended up. That is an *independent* oracle: it shares no
 * code with the renderer's own label maths, so a bug in one cannot hide in the
 * other. Retina was broken for a while precisely because eyeballing screenshots
 * at devicePixelRatio 1 can never catch it.
 *
 * Requires playwright and a chromium: `npm i -D playwright && npx playwright install chromium`.
 * Set CHROME_PATH to use a browser you already have.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flag = n => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

if (!positional[0]) {
  console.error('usage: node scripts/shoot.mjs <file.bp|file.html> [options]');
  process.exit(2);
}

const input = resolve(positional[0]);
const outDir = resolve(opt('out', '/tmp/gridwillow-shots'));
const zooms = opt('zoom', '0.6,1,2,3.5').split(',').map(Number);
const dprs = opt('dpr', '1,2').split(',').map(Number);
const width = Number(opt('width', 1400));
const height = Number(opt('height', 860));
const focus = opt('focus', null);
const TOLERANCE = Number(opt('tolerance', 1.5));   // pixels

mkdirSync(outDir, { recursive: true });

// A .bp gets compiled first; an .html is taken as already built.
let page;
if (extname(input) === '.bp') {
  page = join(outDir, basename(input, '.bp') + '.html');
  const bp = existsSync('target/debug/bp') ? 'target/debug/bp' : 'bp';
  execFileSync(bp, ['export', input, '-o', page], { stdio: ['ignore', 'ignore', 'inherit'] });
} else {
  page = input;
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

/* ---------------------------------------------------------------------------
   The oracle, evaluated in the page. Deliberately re-derives everything from
   the canvas rect and the camera rather than trusting the renderer's own W/H.
--------------------------------------------------------------------------- */
const PROBE = (gap) => {
  const B = window.BLUEPRINT;
  const canvas = document.querySelector('#stage canvas');
  const cv = canvas.getBoundingClientRect();
  const stage = document.getElementById('stage').getBoundingClientRect();

  const Vec3 = Object.getPrototypeOf(B.camera.position).constructor;
  const rows = [];

  for (const el of document.querySelectorAll('.nlabel')) {
    if (el.classList.contains('hidden')) continue;
    const id = el.dataset.node;
    const v = B.nodeViews.get(id);
    if (!v) continue;

    // where the block's apex actually lands on screen
    const p = new Vec3(v.node._x, v.topY, v.node._z).project(B.camera);
    const wantX = cv.left + (p.x * 0.5 + 0.5) * cv.width;
    const wantY = cv.top + (-p.y * 0.5 + 0.5) * cv.height;

    // where the label actually is: bottom-centre, gap pixels above the apex
    const r = el.getBoundingClientRect();
    const gotX = r.left + r.width / 2;
    const gotY = r.bottom + gap;

    rows.push({ id, dx: gotX - wantX, dy: gotY - wantY, w: r.width });
  }

  return {
    rows,
    canvasFitsStage:
      Math.abs(cv.width - stage.width) < 1.5 && Math.abs(cv.height - stage.height) < 1.5,
    canvasCss: [Math.round(cv.width), Math.round(cv.height)],
    stageCss: [Math.round(stage.width), Math.round(stage.height)],
    drawingBufferRatio: canvas.width / cv.width,
    dpr: window.devicePixelRatio,
    // every label the same width means measurement latched onto a default
    distinctWidths: new Set([...document.querySelectorAll('.nlabel')]
      .filter(e => !e.classList.contains('hidden'))
      .map(e => Math.round(e.getBoundingClientRect().width))).size,
  };
};

const failures = [];
const shots = [];

/** Wait until the camera stops easing. Measuring mid-animation produced
 *  confident, wrong numbers — the view was still on its way to the fitted
 *  framing when the probe ran. */
async function settle(ctx, timeout = 8000) {
  const started = Date.now();
  let last = null, stableFor = 0;
  while (Date.now() - started < timeout) {
    const c = await ctx.evaluate(() => window.BLUEPRINT.getCamera());
    const same = last &&
      Math.abs(c.zoom - last.zoom) < 1e-4 &&
      Math.abs(c.x - last.x) < 1e-3 && Math.abs(c.z - last.z) < 1e-3;
    stableFor = same ? stableFor + 1 : 0;
    if (stableFor >= 3) return;
    last = c;
    await ctx.waitForTimeout(120);
  }
}

/* ---------------------------------------------------------------------------
   Touch. Playwright's mouse API produces mouse pointer events, which is not
   what a phone sends, so gestures go through CDP as real touch events. This is
   the only way to prove panning works: `touch-action` defaulting to `auto` lets
   the browser claim the gesture as a page scroll and silently cancel the
   pointer stream, which looks identical to a renderer that ignores input.
--------------------------------------------------------------------------- */
async function touchDrag(cdp, from, to, steps = 8) {
  const pt = (p, id = 0) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(from)] });
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + (to.x - from.x) * (i / steps), y: from.y + (to.y - from.y) * (i / steps) };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(p)] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function pinch(cdp, centre, fromGap, toGap, steps = 8) {
  const pts = gap => [
    { x: centre.x - gap / 2, y: centre.y, id: 0, radiusX: 12, radiusY: 12, force: 1 },
    { x: centre.x + gap / 2, y: centre.y, id: 1, radiusX: 12, radiusY: 12, force: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(fromGap) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pts(fromGap + (toGap - fromGap) * (i / steps)),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

if (flag('mobile')) {
  const phone = { width: 390, height: 844 };
  const ctx = await browser.newPage({
    viewport: phone, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  const errs = [];
  ctx.on('pageerror', e => errs.push(e.message.slice(0, 200)));
  await ctx.goto('file://' + page);
  await ctx.waitForFunction(() => window.BLUEPRINT && (window.__bpFrames || 0) > 2, { timeout: 20000 });
  await settle(ctx);
  const cdp = await ctx.context().newCDPSession(ctx);

  const fit = await ctx.evaluate(() => {
    const cv = document.querySelector('#stage canvas').getBoundingClientRect();
    const st = document.getElementById('stage').getBoundingClientRect();
    return {
      ok: Math.abs(cv.width - st.width) < 1.5 && Math.abs(cv.height - st.height) < 1.5,
      canvas: [Math.round(cv.width), Math.round(cv.height)],
      stage: [Math.round(st.width), Math.round(st.height)],
      touchAction: getComputedStyle(document.getElementById('stage')).touchAction,
      drawerBtns: document.querySelectorAll('.drawer-btn').length,
      stageWidthShare: st.width / window.innerWidth,
    };
  });
  if (!fit.ok) failures.push(`mobile: canvas ${fit.canvas} in stage ${fit.stage}`);

  // At rest the whole drawing should be on screen. A fit computed against a
  // stale stage size looks fine in a screenshot's centre and hangs off an edge.
  const framing = await ctx.evaluate(() => {
    const B = window.BLUEPRINT;
    const cv = document.querySelector('#stage canvas').getBoundingClientRect();
    const V = Object.getPrototypeOf(B.camera.position).constructor;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const eat = (x0, y0, x1, y1) => {
      minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
      minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
    };
    for (const v of B.nodeViews.values()) {
      const p = new V(v.node._x, v.topY, v.node._z).project(B.camera);
      const x = (p.x * 0.5 + 0.5) * cv.width, y = (-p.y * 0.5 + 0.5) * cv.height;
      eat(x, y, x, y);
    }
    // Labels are what actually hangs off the edge — a block can sit comfortably
    // inside the frame while its name is clipped in half.
    for (const el of document.querySelectorAll('.nlabel')) {
      if (el.classList.contains('hidden')) continue;
      const r = el.getBoundingClientRect();
      eat(r.left - cv.left, r.top - cv.top, r.right - cv.left, r.bottom - cv.top);
    }
    return { minX, maxX, minY, maxY, w: cv.width, h: cv.height };
  });
  const spill = Math.max(-framing.minX, -framing.minY,
                         framing.maxX - framing.w, framing.maxY - framing.h);
  if (spill > 4) {
    failures.push(`mobile: the fitted view spills ${spill.toFixed(0)}px past the canvas — blocks are off screen`);
  }
  if (fit.touchAction !== 'none') {
    failures.push(`mobile: #stage touch-action is "${fit.touchAction}" — the browser will eat the gestures`);
  }
  if (fit.drawerBtns < 2) failures.push('mobile: the index/notes drawer buttons are missing');
  if (fit.stageWidthShare < 0.9) {
    failures.push(`mobile: the drawing only gets ${(fit.stageWidthShare * 100).toFixed(0)}% of the width`);
  }

  await ctx.screenshot({ path: join(outDir, 'mobile-idle.png') });
  shots.push('mobile-idle.png');

  // pan
  const before = await ctx.evaluate(() => ({ ...window.BLUEPRINT.getCamera() }));
  await touchDrag(cdp, { x: 200, y: 480 }, { x: 300, y: 400 });
  await ctx.waitForTimeout(500);
  const afterPan = await ctx.evaluate(() => ({ ...window.BLUEPRINT.getCamera() }));
  const moved = Math.hypot(afterPan.x - before.x, afterPan.z - before.z);
  if (moved < 0.5) failures.push(`mobile: a touch drag moved the camera ${moved.toFixed(2)} units — panning is dead`);

  // pinch
  await pinch(cdp, { x: 195, y: 460 }, 80, 220);
  await ctx.waitForTimeout(500);
  const afterPinch = await ctx.evaluate(() => ({ ...window.BLUEPRINT.getCamera() }));
  const zoomRatio = afterPinch.zoom / afterPan.zoom;
  if (zoomRatio < 1.4) failures.push(`mobile: a pinch changed zoom by ${zoomRatio.toFixed(2)}x — expected roughly 2.75x`);

  await ctx.screenshot({ path: join(outDir, 'mobile-zoomed.png') });
  shots.push('mobile-zoomed.png');

  // The drawers. Wait for the slide to *settle* rather than sleeping a fixed
  // amount: a headless GPU is slow enough that a 180ms CSS transition can take
  // seconds of wall clock, and a fixed sleep turns that into a phantom failure.
  await ctx.click('.drawer-btn[data-drawer="notes"]');
  let notesOpen = false;
  try {
    await ctx.waitForFunction(() => {
      const r = document.querySelector('#narr').getBoundingClientRect();
      return r.right <= window.innerWidth + 1 && r.left < window.innerWidth - 20;
    }, { timeout: 8000 });
    notesOpen = true;
  } catch { /* reported below */ }
  if (!notesOpen) failures.push('mobile: the notes drawer never slid in');

  // And it must be dismissable, or a phone user is stuck behind it. Tap the
  // strip of scrim the drawer does not cover — its centre is *under* the
  // drawer, which is the whole point of the drawer.
  await ctx.screenshot({ path: join(outDir, 'mobile-notes.png') });
  shots.push('mobile-notes.png');
  await ctx.touchscreen.tap(18, 520);
  let notesClosed = false;
  try {
    await ctx.waitForFunction(
      () => document.querySelector('#narr').getBoundingClientRect().left >= window.innerWidth - 1,
      { timeout: 8000 });
    notesClosed = true;
  } catch { /* reported below */ }
  if (!notesClosed) failures.push('mobile: tapping the scrim did not dismiss the notes drawer');
  await ctx.click('.drawer-btn[data-drawer="notes"]');
  await ctx.waitForTimeout(2200);
  console.log(
    `  mobile 390x844  canvas ${fit.canvas.join('x')} in stage ${fit.stage.join('x')}  ` +
    `touch-action ${fit.touchAction}  pan ${moved.toFixed(1)}u  pinch ${zoomRatio.toFixed(2)}x`
  );
  if (errs.length) failures.push(`mobile: page errors — ${errs.join(' | ')}`);
  await ctx.close();
}

for (const dpr of dprs) {
  const ctx = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  const consoleErrors = [];
  ctx.on('pageerror', e => consoleErrors.push(e.message.slice(0, 200)));
  await ctx.goto('file://' + page);
  await ctx.waitForFunction(() => window.BLUEPRINT && (window.__bpFrames || 0) > 2, { timeout: 20000 });

  if (focus) {
    await ctx.evaluate(id => window.BLUEPRINT.focus(id), focus);
    if (flag('inspect')) await ctx.evaluate(id => window.BLUEPRINT.inspect(id), focus);
    await ctx.waitForTimeout(900);
  }

  for (const zoom of zooms) {
    // drive the camera through the same state the UI mutates, then let the
    // easing settle so the screenshot is of a resting frame
    await ctx.evaluate(z => {
      const c = window.BLUEPRINT.cam || null;
      if (c) { c.zoomGoal = z; c.zoom = z; }
    }, zoom);
    await ctx.waitForTimeout(500);
    await settle(ctx, 4000);

    const name = `${basename(page, '.html')}@${zoom}x-dpr${dpr}.png`;
    await ctx.screenshot({ path: join(outDir, name) });
    shots.push(name);

    const probe = await ctx.evaluate(PROBE, 7);

    if (probe.rows.length === 0) {
      failures.push(
        `dpr ${dpr} zoom ${zoom}: no labels were measured. Either every one is ` +
        `hidden, or they lost their data-node attribute and the probe matched ` +
        `nothing — a check with no rows is not a passing check.`
      );
    }
    if (!probe.canvasFitsStage) {
      failures.push(
        `dpr ${dpr} zoom ${zoom}: canvas is ${probe.canvasCss} CSS px inside a ` +
        `${probe.stageCss} stage — the drawing is scaled and clipped`
      );
    }
    if (probe.distinctWidths === 1 && probe.rows.length > 3) {
      failures.push(`dpr ${dpr} zoom ${zoom}: every label reports the same width — measurement never ran`);
    }
    const worst = probe.rows
      .map(r => ({ ...r, err: Math.hypot(r.dx, r.dy) }))
      .sort((a, b) => b.err - a.err)[0];
    if (worst && worst.err > TOLERANCE) {
      failures.push(
        `dpr ${dpr} zoom ${zoom}: "${worst.id}" label is off by ` +
        `${worst.err.toFixed(1)}px (dx ${worst.dx.toFixed(1)}, dy ${worst.dy.toFixed(1)})`
      );
    }

    console.log(
      `  dpr ${dpr}  zoom ${String(zoom).padEnd(4)}  ` +
      `labels ${String(probe.rows.length).padStart(2)}  ` +
      `worst ${worst ? worst.err.toFixed(2).padStart(5) : '  n/a'}px  ` +
      `canvas ${probe.canvasCss.join('x')} in stage ${probe.stageCss.join('x')}  ` +
      `buffer ${probe.drawingBufferRatio.toFixed(1)}x`
    );
  }

  if (consoleErrors.length) failures.push(`dpr ${dpr}: page errors — ${consoleErrors.join(' | ')}`);
  await ctx.close();
}

await browser.close();

console.log(`\n${shots.length} shots in ${outDir}`);
if (failures.length) {
  console.error('\nFAILED');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(flag('check') ? 'all checks passed' : 'rendered (pass --check to fail the build on drift)');
