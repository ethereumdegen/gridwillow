#!/usr/bin/env node
/**
 * shoot.mjs — the visual test harness.
 *
 *   node scripts/shoot.mjs examples/payments.bp
 *   node scripts/shoot.mjs examples/payments.bp --zoom 0.5,1,2,4 --dpr 1,2
 *   node scripts/shoot.mjs examples/payments.bp --check           # assert, don't just look
 *   node scripts/shoot.mjs examples/payments.bp --focus orders --inspect
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
    await ctx.waitForTimeout(700);

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
