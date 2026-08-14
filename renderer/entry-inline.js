/* ==========================================================================
   entry-inline — the exported, self-contained HTML
   ---------------------------------------------------------------------------
   Reads the IR out of the inline JSON block and mounts it once. There is no
   reload path here: an exported blueprint is a fixed picture of one moment,
   and the app is what you use when you want it to move.

   `bp export` concatenates this file after blueprint.js and drops the import
   line below, so keep that import on a line of its own.
   ========================================================================== */

import { createBlueprint } from './blueprint.js';

window.__bpStarted = true;   // tells the shell's watchdog to stand down

function fail(message) {
  const el = document.getElementById('nodata');
  el.classList.add('on');
  const p = document.createElement('p');
  p.className = 'err';
  p.textContent = '/ ' + message;
  el.querySelector('.box').appendChild(p);
  throw new Error(message);
}

function read() {
  const tag = document.getElementById('bp-data');
  if (!tag) fail('no #bp-data block in the document');
  const raw = tag.textContent.trim();
  // Assembled rather than spelled out: the exporter substitutes this sentinel
  // across the whole document, and a literal copy here would be replaced too —
  // injecting the entire blueprint into the middle of a string.
  const SENTINEL = '__' + 'DATA' + '__';
  if (!raw || raw.indexOf(SENTINEL) !== -1) fail('the data block was never filled in');

  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    fail('the data block is not valid JSON — ' + e.message);
  }
  // Accept any 1.x: added fields are additive, and refusing to draw an older
  // file because a newer one gained a section would be obnoxious.
  if (!String(d.codeviz || '').startsWith('1.')) {
    fail('unsupported blueprint version: ' + d.codeviz);
  }
  for (const k of ['meta', 'groups', 'nodes', 'edges', 'narrative']) {
    if (!d[k]) fail('the blueprint is missing its `' + k + '`');
  }
  return d;
}

const bp = createBlueprint(read(), { root: document.getElementById('app-root') });

if (bp.problems.length) {
  console.warn(
    '[blueprint] ' + bp.problems.length + ' reference problem(s):\n  ' + bp.problems.join('\n  ')
  );
}

// a small surface for the automated checks and for poking from the console
window.BLUEPRINT = bp;
