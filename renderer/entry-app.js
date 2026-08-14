/* ==========================================================================
   entry-app — the Tauri viewer
   ---------------------------------------------------------------------------
   Same renderer, different plumbing. Rust owns the file: it compiles the .bp,
   watches it, and pushes a new IR every time it changes. This side's whole job
   is to swap one drawing for another without losing your place.

   Camera state is carried across a reload deliberately. If tweaking a `why`
   line snapped you back to the fitted view every save, you would stop tweaking.
   ========================================================================== */

import { createBlueprint } from './blueprint.js';

const { listen, emit } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

window.__bpStarted = true;

const rootEl = document.getElementById('app-root');
const noDataEl = document.getElementById('nodata');
let bp = null;
let lastCamera = null;

function showIdle(title, lines) {
  if (bp) {
    lastCamera = bp.getCamera();
    bp.dispose();
    bp = null;
  }
  noDataEl.classList.add('on');
  const box = noDataEl.querySelector('.box');
  box.innerHTML = `<h1>${escapeHtml(title)}</h1>`;
  for (const l of lines) {
    const p = document.createElement('p');
    p.className = l.startsWith('/') ? 'err' : '';
    p.textContent = l;
    box.appendChild(p);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/** Swap in a new drawing, keeping the camera where the user left it. */
function mount(ir) {
  noDataEl.classList.remove('on');
  const camera = bp ? bp.getCamera() : lastCamera;
  if (bp) bp.dispose();
  bp = createBlueprint(ir, { root: rootEl, camera });
  window.BLUEPRINT = bp;
  if (bp.problems.length) {
    console.warn('[blueprint] ' + bp.problems.join('\n  '));
  }
}

/* ---- messages from Rust -------------------------------------------------- */

listen('blueprint://loaded', ev => {
  const { ir, warnings } = ev.payload;
  mount(ir);
  if (warnings?.length) console.info('[blueprint] ' + warnings.join('\n  '));
});

/* A file that no longer parses keeps the last good drawing on screen and shows
   the errors over it, because blanking the window on every half-typed line is
   the fastest way to make a live-reload loop unusable. */
listen('blueprint://error', ev => {
  const { rendered, fatal } = ev.payload;
  if (fatal || !bp) {
    showIdle('That file will not parse', String(rendered).split('\n').filter(Boolean));
  } else {
    console.error('[blueprint]\n' + rendered);
    flashError(rendered);
  }
});

listen('blueprint://closed', () => {
  showIdle('No blueprint open', ['Open a .bp file, or drop one on the window.']);
});

/* ---- a non-blocking error strip over the drawing -------------------------- */

let strip = null;
let stripTimer = 0;

function flashError(text) {
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'errstrip';
    document.body.appendChild(strip);
  }
  const first = String(text).split('\n').slice(0, 6).join('\n');
  strip.textContent = first;
  strip.classList.add('on');
  clearTimeout(stripTimer);
  stripTimer = setTimeout(() => strip.classList.remove('on'), 6000);
}

/* ---- drag and drop ------------------------------------------------------- */

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

listen('tauri://drag-drop', ev => {
  const path = ev.payload?.paths?.[0];
  if (path) invoke('open_blueprint', { path }).catch(err => console.error(err));
});

/* ---- ask Rust for whatever it already has -------------------------------- */

invoke('current_blueprint')
  .then(res => {
    if (res) mount(res.ir);
    else showIdle('No blueprint open', ['Open a .bp file, or drop one on the window.']);
  })
  .catch(() => showIdle('No blueprint open', ['Open a .bp file, or drop one on the window.']));

/* Let Rust drive the menu actions that need the webview's state. */
listen('blueprint://request-export', async () => {
  await emit('blueprint://export-ready', { camera: bp ? bp.getCamera() : null });
});
