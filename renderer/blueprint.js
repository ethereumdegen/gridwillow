/* ==========================================================================
   blueprint — the renderer
   ---------------------------------------------------------------------------
   Fixed. Nobody authoring a blueprint edits this file; they write a .bp and the
   compiler hands the result here as an IR object.

   Everything is deterministic — no Math.random, no clock-seeded values — so the
   same document always produces the same drawing, and you can edit one block,
   reload, and see exactly what moved.
   ========================================================================== */

import * as THREE from 'three';

export const IR_VERSION = '1.1';

const SHELL = `
<div id="app">
  <div id="topbar"></div>
  <div id="sidebar"></div>
  <div id="stage">
    <div id="labels"></div>
    <div id="card"></div>
  </div>
  <div id="narr">
    <div id="tabs"></div>
    <div id="narrbody"></div>
    <div id="inspector">
      <div id="insp-head">
        <div class="row"><span class="kind"></span><button class="close" type="button">esc</button></div>
        <h2></h2>
        <div class="sum"></div>
      </div>
      <div id="insp-body"></div>
    </div>
  </div>
  <div id="botbar"></div>
</div>`;

/**
 * Draw a blueprint into an element.
 *
 * @param {object} DATA  the compiled IR
 * @param {object} opts  { root: HTMLElement, camera?: state to restore }
 * @returns {{dispose: function, getCamera: function, focus: function,
 *            data: object, problems: string[]}}
 */
export function createBlueprint(DATA, opts = {}) {
  const root = opts.root || document.body;
  const ac = new AbortController();
  const signal = ac.signal;
  let alive = true;
  let rafId = 0;
  let frames = 0;

  root.innerHTML = SHELL;
  const stage    = root.querySelector('#stage');
  const labelsEl = root.querySelector('#labels');
  const cardEl   = root.querySelector('#card');
  const inspEl   = root.querySelector('#inspector');

  // The IR is mutated in place by the integrity pass below, so work on a copy —
  // a caller that reloads the same object should not see it degrade each time.
  DATA = JSON.parse(JSON.stringify(DATA));

  /* ---------- palette (mirrors style.css; keep in sync) --------------------- */

  const C = {
    paper:    0xcdc499,
    top:      0xd9d1a7,
    side_a:   0xc4bb90,
    side_b:   0xb2a97f,
    bottom:   0xa89f76,
    ink:      0x2f2c19,
    inkSoft:  0x6b6340,
    inkFaint: 0x9a9270,
    rule:     0xa79f79,
    ruleSoft: 0xb9b18c,
    live:     0x8a4c14,
    liveHi:   0xb4681f,
  };

  /* ---------- geometry vocabulary ------------------------------------------
     kind -> footprint [x,z], height, hatch pattern, sidebar glyph.
     Fixed table. New kinds are not allowed; the schema enforces the enum.
     ------------------------------------------------------------------------ */

  const KIND = {
    entrypoint: { fp: [0.72, 0.72], h: 1.45, hatch: 'v', glyph: '>' },
    service:    { fp: [1.06, 1.06], h: 0.86, hatch: 'v', glyph: '#' },
    store:      { fp: [1.92, 1.55], h: 0.30, hatch: 'x', glyph: '=' , slabs: 5 },
    queue:      { fp: [1.45, 0.98], h: 0.76, hatch: 'v', glyph: '|' , ribs: 7 },
    model:      { fp: [0.96, 0.96], h: 0.88, hatch: 'v', glyph: 'o' , knob: true },
    library:    { fp: [1.32, 1.02], h: 0.20, hatch: 'p', glyph: '-' },
    external:   { fp: [0.98, 0.98], h: 0.72, hatch: 'p', glyph: '~' , ghost: true },
    job:        { fp: [0.64, 0.64], h: 0.54, hatch: 'd', glyph: '*' , lift: 0.60 },
  };

  const EDGE_STYLE = {
    data:  { dash: null,        packet: 'cube' },
    call:  { dash: null,        packet: 'cone', arrow: true },
    event: { dash: [0.22, 0.16], packet: 'octa' },
    read:  { dash: [0.10, 0.12], packet: 'flat' },
    write: { dash: null,        packet: 'flat', double: true, arrow: true },
    spawn: { dash: [0.05, 0.14], packet: 'octa' },
  };

  const CELL_X = 3.15;   // world units per layout column
  const CELL_Z = 2.85;   // world units per layout row
  const GROUND = 0.0;
  const WIRE_Y = 0.035;  // connectors float just above the floor
  const CHAMFER = 0.30;  // corner cut on orthogonal routes

  /* index + integrity pass ---------------------------------------------------
     Bad references are dropped rather than thrown, so a nearly-correct blueprint
     still renders and the problem is visible in the console.                  */

  const nodeById = new Map();
  for (const n of DATA.nodes) nodeById.set(n.id, n);

  const groupById = new Map();
  DATA.groups.forEach((g, i) => { g._order = (g.order ?? i); groupById.set(g.id, g); });
  const groupsOrdered = DATA.groups.slice().sort((a, b) => a._order - b._order);

  const problems = [];
  DATA.nodes = DATA.nodes.filter(n => {
    if (!groupById.has(n.group)) { problems.push(`node "${n.id}" -> unknown group "${n.group}"`); return false; }
    if (!KIND[n.kind])           { problems.push(`node "${n.id}" -> unknown kind "${n.kind}"`);   return false; }
    return true;
  });
  nodeById.clear();
  for (const n of DATA.nodes) nodeById.set(n.id, n);

  DATA.edges = DATA.edges.filter(e => {
    if (!nodeById.has(e.from)) { problems.push(`edge "${e.id}" -> unknown from "${e.from}"`); return false; }
    if (!nodeById.has(e.to))   { problems.push(`edge "${e.id}" -> unknown to "${e.to}"`);     return false; }
    if (e.from === e.to)       { problems.push(`edge "${e.id}" -> self loop, dropped`);        return false; }
    return true;
  });
  if (problems.length) console.warn('[codeviz] ' + problems.length + ' reference problem(s):\n  ' + problems.join('\n  '));

  const degree = new Map(DATA.nodes.map(n => [n.id, 0]));
  for (const e of DATA.edges) {
    degree.set(e.from, degree.get(e.from) + 1);
    degree.set(e.to,   degree.get(e.to)   + 1);
  }

  /* ==========================================================================
     1. layout — deterministic, groups as bands, longest-path ranks within
     ========================================================================== */

  function layout() {
    const outAdj = new Map(DATA.nodes.map(n => [n.id, []]));
    const inDeg  = new Map(DATA.nodes.map(n => [n.id, 0]));
    for (const e of DATA.edges) {
      outAdj.get(e.from).push(e.to);
      inDeg.set(e.to, inDeg.get(e.to) + 1);
    }

    // longest-path rank over the whole graph (cycle-safe: bounded relaxation)
    const rank = new Map(DATA.nodes.map(n => [n.id, 0]));
    const order = DATA.nodes.map(n => n.id);
    for (let pass = 0; pass < Math.min(DATA.nodes.length, 24); pass++) {
      let moved = false;
      for (const id of order) {
        for (const t of outAdj.get(id)) {
          const want = rank.get(id) + 1;
          if (rank.get(t) < want) { rank.set(t, want); moved = true; }
        }
      }
      if (!moved) break;
    }

    /* Each group becomes a rectangular plot. Inside a plot, compacted rank runs
       left-to-right and same-rank nodes stack front-to-back. */
    const plots = [];
    for (const g of groupsOrdered) {
      const members = DATA.nodes.filter(n => n.group === g.id);
      if (!members.length) continue;

      // Compact ranks inside the group: take the DISTINCT ranks its members
      // occupy and renumber them 0,1,2… Subtracting the minimum is not enough —
      // a group whose members sit at global ranks 0 and 9 would otherwise leave
      // eight empty columns and smear the drawing across the floor.
      const distinct = [...new Set(members.map(m => rank.get(m.id)))].sort((a, b) => a - b);
      const compact = new Map(distinct.map((r, i) => [r, i]));
      const cols = new Map();
      for (const m of members) {
        const c = compact.get(rank.get(m.id));
        if (!cols.has(c)) cols.set(c, []);
        cols.get(c).push(m);
      }
      const colKeys = [...cols.keys()].sort((a, b) => a - b);
      plots.push({
        g, cols, colKeys,
        w: colKeys.length,
        h: Math.max(...colKeys.map(c => cols.get(c).length)),
      });
    }

    /* Pack the plots for the SCREEN, not for the floor.
       Under this projection screen-x tracks (col - row) and screen-y tracks
       (col + row). So a run of plots laid out along +col alone marches diagonally
       off the corner of the viewport — which is exactly what a naive left-to-right
       pack produces. Stepping +col and -col's partner -row instead keeps a run on
       one horizontal screen line; stepping both +col and +row starts a new one. */

    /* Work in projected coordinates and convert back at the end:
          u = col - row   (screen horizontal)
          v = col + row   (screen vertical, visually squashed by ~1.73)
       A group plot w x h occupies a diamond spanning (w + h - 2) in both u and v.
       Packing in u/v is the only way to get predictable screen gaps — packing in
       col/row leaves voids that grow with each plot's depth. */

    const GAP = 3.2;
    const SQUASH = Math.sqrt(3);                       // u units per v unit on screen
    const span = p => p.w + p.h - 2;
    const totalU = plots.reduce((s, p) => s + span(p) + GAP, 0);
    const rowScreenH = plots.reduce((s, p) => s + span(p), 0) / plots.length / SQUASH + GAP;
    const ROWS = Math.min(4, Math.max(1, Math.round(Math.sqrt(totalU / (1.7 * rowScreenH)))));
    const budgetU = totalU / ROWS;

    let u = 0, v = 0, usedU = 0, rowMax = 0;
    for (const p of plots) {
      if (usedU > 0 && usedU + span(p) + GAP > budgetU * 1.15) {
        v += rowMax + GAP * 0.55 * SQUASH;             // down one screen row
        u = 0; usedU = 0; rowMax = 0;
      }
      const uMin = u, vMid = v;
      const sum = vMid - span(p) / 2;                  // = x + y
      const dif = uMin + p.h - 1;                      // = x - y
      p.x = (sum + dif) / 2;
      p.y = (sum - dif) / 2;
      u += span(p) + GAP;
      usedU += span(p) + GAP;
      rowMax = Math.max(rowMax, span(p));
    }

    const placed = [];
    for (const p of plots) {
      for (const c of p.colKeys) {
        const stack = p.cols.get(c);
        const offset = (p.h - stack.length) / 2;   // centre the stack in its plot
        stack.forEach((m, i) => {
          if (Array.isArray(m.pos)) { m._col = m.pos[0]; m._row = m.pos[1]; }
          else { m._col = p.x + p.colKeys.indexOf(c); m._row = p.y + offset + i; }
          placed.push(m);
        });
      }
      p.g._plot = [p.x, p.y, p.w, p.h];
    }

    // world coords
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of placed) {
      n._x = n._col * CELL_X;
      n._z = n._row * CELL_Z;
      minX = Math.min(minX, n._x); maxX = Math.max(maxX, n._x);
      minZ = Math.min(minZ, n._z); maxZ = Math.max(maxZ, n._z);
    }
    // recentre on the origin so the camera framing is stable
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    for (const n of placed) { n._x -= cx; n._z -= cz; }

    return { width: maxX - minX, depth: maxZ - minZ };
  }

  const EXTENT = layout();

  /* ==========================================================================
     2. three.js scaffolding
     ========================================================================== */

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.paper);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(C.paper, 1);
  stage.appendChild(renderer.domElement);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 900);
  camera.up.set(0, 1, 0);

  const ISO_DIR = new THREE.Vector3(1, 1, 1).normalize(); // true isometric
  const DIST = 120;

  const cam = {
    target: new THREE.Vector3(0, 0, 0),
    targetGoal: new THREE.Vector3(0, 0, 0),
    zoom: 1, zoomGoal: 1,
    yawStep: 0, yawAngle: 0, yawGoal: 0,
  };

  const BASE_SPAN = Math.max(EXTENT.width, EXTENT.depth, 8) * 0.55 + 4;

  function frustumFor(zoom) {
    const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
    const aspect = w / h;
    const halfH = BASE_SPAN / zoom;
    const halfW = halfH * aspect;
    return { halfW, halfH };
  }

  function applyCamera() {
    const { halfW, halfH } = frustumFor(cam.zoom);
    camera.left = -halfW; camera.right = halfW;
    camera.top = halfH;  camera.bottom = -halfH;
    const dir = ISO_DIR.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), cam.yawAngle);
    camera.position.copy(cam.target).addScaledVector(dir, DIST);
    camera.lookAt(cam.target);
    camera.updateProjectionMatrix();
  }

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    // updateStyle must stay ON. Without it three sets only the canvas's width
    // and height *attributes* — which are multiplied by the pixel ratio — and
    // the element then lays out at that intrinsic size. On a retina display
    // that is a canvas twice the size of its container: the drawing renders
    // double and clipped, and every screen-space calculation that uses the
    // container's dimensions (labels, picking, fit) is off by the ratio.
    renderer.setSize(w, h);
    applyCamera();
  }
  const _ro = new ResizeObserver(resize); _ro.observe(stage);

  /* ---------- hatch textures ------------------------------------------------ */

  const texCache = new Map();
  function hatch(kind) {
    if (texCache.has(kind)) return texCache.get(kind);
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(47,44,25,0.30)';
    g.lineWidth = 1;
    if (kind === 'v') {
      for (let x = 3; x < S; x += 7) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, S); g.stroke(); }
    } else if (kind === 'x') {
      g.strokeStyle = 'rgba(47,44,25,0.24)';
      for (let i = -S; i < S * 2; i += 6) {
        g.beginPath(); g.moveTo(i, 0);     g.lineTo(i + S, S); g.stroke();
        g.beginPath(); g.moveTo(i, S);     g.lineTo(i + S, 0); g.stroke();
      }
    } else if (kind === 'd') {
      g.fillStyle = 'rgba(47,44,25,0.30)';
      for (let y = 4; y < S; y += 10) for (let x = 4; x < S; x += 10) g.fillRect(x, y, 2, 2);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    texCache.set(kind, t);
    return t;
  }

  /* ---------- ground: fine grid + group plots ------------------------------- */

  (function ground() {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(47,44,25,0.055)'; g.lineWidth = 1;
    for (let i = 0; i <= S; i += 16) {
      g.beginPath(); g.moveTo(i + .5, 0); g.lineTo(i + .5, S); g.stroke();
      g.beginPath(); g.moveTo(0, i + .5); g.lineTo(S, i + .5); g.stroke();
    }
    g.strokeStyle = 'rgba(47,44,25,0.10)';
    g.strokeRect(.5, .5, S - 1, S - 1);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.repeat.set(90, 90);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshBasicMaterial({ map: t, color: C.paper })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = GROUND - 0.01;
    plane.renderOrder = -10;
    scene.add(plane);
  })();

  (function groupPlots() {
    const mat = new THREE.LineBasicMaterial({ color: C.rule, transparent: true, opacity: 0.9 });
    for (const g of groupsOrdered) {
      const members = DATA.nodes.filter(n => n.group === g.id);
      if (members.length < 2) continue;
      const pad = 1.35;
      const xs = members.map(m => m._x), zs = members.map(m => m._z);
      const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
      const z0 = Math.min(...zs) - pad, z1 = Math.max(...zs) + pad;
      const y = GROUND + 0.006;
      const pts = [
        new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0),
        new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1),
        new THREE.Vector3(x0, y, z0),
      ];
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
  })();

  /* ==========================================================================
     3. nodes
     ========================================================================== */

  const nodeViews = new Map();   // id -> { group, outlineMats[], pickMeshes[], node }
  const pickNodes = [];

  function faceMaterials(spec, node) {
    const map = hatch(spec.hatch);
    const ghost = spec.ghost || node.status === 'planned';
    const dormant = node.status === 'dormant';
    const mk = (col, useMap) => new THREE.MeshBasicMaterial({
      color: col,
      map: useMap ? map : null,
      transparent: ghost || dormant,
      opacity: ghost ? 0.16 : (dormant ? 0.55 : 1),
    });
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    return [
      mk(C.side_a, true), mk(C.side_a, true),
      mk(C.top, spec.hatch === 'x'), mk(C.bottom, false),
      mk(C.side_b, true), mk(C.side_b, true),
    ];
  }

  function outlineFor(geo, node) {
    const mat = new THREE.LineBasicMaterial({
      color: C.ink,
      transparent: true,
      opacity: node.status === 'planned' ? 0.45 : (node.status === 'dormant' ? 0.6 : 0.95),
    });
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), mat);
    return { line, mat };
  }

  function buildNode(node) {
    const spec = KIND[node.kind];
    const w = Math.max(0.5, node.weight ?? 1);
    const fx = spec.fp[0] * (0.7 + 0.3 * w);
    const fz = spec.fp[1] * (0.7 + 0.3 * w);
    const hy = spec.h * w;

    const grp = new THREE.Group();
    grp.position.set(node._x, GROUND + (spec.lift ? spec.lift * w : 0), node._z);

    const outlineMats = [];
    const picks = [];

    const addBox = (sx, sy, sz, px, py, pz, matsOverride) => {
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mesh = new THREE.Mesh(geo, matsOverride || faceMaterials(spec, node));
      mesh.position.set(px, py, pz);
      const o = outlineFor(geo, node);
      o.line.position.copy(mesh.position);
      grp.add(mesh, o.line);
      outlineMats.push(o.mat);
      picks.push(mesh);
      return mesh;
    };

    if (node.kind === 'queue') {
      // ribbed stack of thin plates reading as a buffer
      const n = spec.ribs;
      const t = fx / (n * 1.55);
      for (let i = 0; i < n; i++) {
        const px = -fx / 2 + t * 0.8 + (i * (fx - t * 1.6)) / (n - 1);
        addBox(t, hy, fz, px, hy / 2, 0);
      }
    } else if (node.kind === 'store') {
      // laminated slab: a few stacked sheets
      const n = spec.slabs;
      const t = hy / n;
      for (let i = 0; i < n; i++) {
        const inset = i * 0.012;
        addBox(fx - inset * 2, t * 0.86, fz - inset * 2, 0, t / 2 + i * t, 0);
      }
    } else {
      addBox(fx, hy, fz, 0, hy / 2, 0);
      if (spec.knob) {
        const kg = new THREE.SphereGeometry(0.085, 10, 8);
        const km = new THREE.Mesh(kg, new THREE.MeshBasicMaterial({ color: C.ink }));
        km.position.set(fx / 2 - 0.13, hy + 0.06, -fz / 2 + 0.13);
        grp.add(km);
      }
      if (spec.lift) {
        // a hairline dropping to the floor so floating jobs read as anchored
        const stem = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -spec.lift * w, 0),
          ]),
          new THREE.LineBasicMaterial({ color: C.inkFaint, transparent: true, opacity: 0.7 })
        );
        grp.add(stem);
      }
    }

    scene.add(grp);
    // The exact top of the block. Any padding added here would be in WORLD
    // units, so the gap between a label and its block would grow and shrink
    // with zoom. The gap is applied in pixels at draw time instead.
    const topY = grp.position.y + hy + (spec.knob ? 0.17 : 0);
    const view = { node, group: grp, outlineMats, topY, fx, fz, hy };
    nodeViews.set(node.id, view);
    for (const p of picks) { p.userData.nodeId = node.id; pickNodes.push(p); }
    return view;
  }

  for (const n of DATA.nodes) buildNode(n);

  /* ==========================================================================
     4. connectors
     ========================================================================== */

  function edgeAnchor(view, towardX, towardZ) {
    // step out to the block's silhouette so lines start at an edge, not a centre
    const dx = towardX - view.node._x, dz = towardZ - view.node._z;
    const ax = view.fx / 2 + 0.14, az = view.fz / 2 + 0.14;
    if (Math.abs(dx) * az > Math.abs(dz) * ax) {
      return [view.node._x + Math.sign(dx) * ax, view.node._z];
    }
    return [view.node._x, view.node._z + Math.sign(dz) * az];
  }

  function orthoRoute(a, b) {
    const [ax, az] = a, [bx, bz] = b;
    if (Math.abs(ax - bx) < 0.02) return [[ax, az], [ax, bz]];
    if (Math.abs(az - bz) < 0.02) return [[ax, az], [bx, az]];
    if (Math.abs(bx - ax) >= Math.abs(bz - az)) {
      const m = (ax + bx) / 2;
      return [[ax, az], [m, az], [m, bz], [bx, bz]];
    }
    const m = (az + bz) / 2;
    return [[ax, az], [ax, m], [bx, m], [bx, bz]];
  }

  function chamfer(pts, r) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      const la = Math.hypot(p[0] - a[0], p[1] - a[1]);
      const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
      const ra = Math.min(r, la * 0.45), rb = Math.min(r, lb * 0.45);
      if (la < 1e-4 || lb < 1e-4) { out.push(p); continue; }
      out.push([p[0] + (a[0] - p[0]) / la * ra, p[1] + (a[1] - p[1]) / la * ra]);
      out.push([p[0] + (b[0] - p[0]) / lb * rb, p[1] + (b[1] - p[1]) / lb * rb]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function toVec3(pts, y) { return pts.map(p => new THREE.Vector3(p[0], y, p[1])); }

  const edgeViews = new Map();
  const pickEdges = [];
  const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

  function buildEdge(e) {
    const A = nodeViews.get(e.from), B = nodeViews.get(e.to);
    const style = EDGE_STYLE[e.kind] || EDGE_STYLE.data;

    let coarse;
    if (Array.isArray(e.waypoints) && e.waypoints.length) {
      const wp = e.waypoints.map(([c, r]) => [c * CELL_X, r * CELL_Z]);
      const a = edgeAnchor(A, wp[0][0], wp[0][1]);
      const b = edgeAnchor(B, wp[wp.length - 1][0], wp[wp.length - 1][1]);
      coarse = [a];
      let cur = a;
      for (const w of wp) { coarse.push(...orthoRoute(cur, w).slice(1)); cur = w; }
      coarse.push(...orthoRoute(cur, b).slice(1));
    } else {
      const a = edgeAnchor(A, B.node._x, B.node._z);
      const b = edgeAnchor(B, A.node._x, A.node._z);
      coarse = orthoRoute(a, b);
    }

    const pts2 = chamfer(coarse, CHAMFER);
    const y = WIRE_Y + (edgeViews.size % 3) * 0.004;  // deterministic anti-z-fight
    const pts3 = toVec3(pts2, y);

    const lineMat = style.dash
      ? new THREE.LineDashedMaterial({ color: C.ink, dashSize: style.dash[0], gapSize: style.dash[1], transparent: true, opacity: 0.82 })
      : new THREE.LineBasicMaterial({ color: C.ink, transparent: true, opacity: 0.82 });

    const geo = new THREE.BufferGeometry().setFromPoints(pts3);
    const line = new THREE.Line(geo, lineMat);
    if (style.dash) line.computeLineDistances();
    scene.add(line);

    const extraMats = [lineMat];
    if (style.double) {
      const off = 0.055;
      const g2 = new THREE.BufferGeometry().setFromPoints(pts3.map(p => new THREE.Vector3(p.x, p.y + 0.03, p.z + off)));
      const m2 = new THREE.LineBasicMaterial({ color: C.ink, transparent: true, opacity: 0.55 });
      scene.add(new THREE.Line(g2, m2));
      extraMats.push(m2);
    }

    // arrowhead
    if (style.arrow) {
      const p1 = pts3[pts3.length - 1], p0 = pts3[pts3.length - 2];
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.085, 0.24, 4),
        new THREE.MeshBasicMaterial({ color: C.ink })
      );
      cone.position.copy(p1).addScaledVector(dir, -0.12);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      scene.add(cone);
    }

    // pick proxy — invisible but raycastable
    const curve = new THREE.CatmullRomCurve3(pts3, false, 'catmullrom', 0.0);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, pts3.length * 6), 0.17, 4, false), pickMat);
    tube.userData.edgeId = e.id;
    scene.add(tube);
    pickEdges.push(tube);

    // arc-length table for packet travel
    const cum = [0];
    for (let i = 1; i < pts3.length; i++) cum.push(cum[i - 1] + pts3[i].distanceTo(pts3[i - 1]));
    const total = cum[cum.length - 1] || 1;

    const view = {
      edge: e, pts: pts3, cum, total, mats: extraMats,
      baseOpacity: 0.82, speed: 0.16 + (e.volume ?? 0.5) * 0.5, boost: 0,
    };
    edgeViews.set(e.id, view);
    return view;
  }

  for (const e of DATA.edges) buildEdge(e);

  function pointOnEdge(v, t) {
    const d = t * v.total;
    let i = 1;
    while (i < v.cum.length - 1 && v.cum[i] < d) i++;
    const seg = v.cum[i] - v.cum[i - 1] || 1;
    const f = (d - v.cum[i - 1]) / seg;
    return v.pts[i - 1].clone().lerp(v.pts[i], f);
  }

  /* ---------- packets ------------------------------------------------------- */

  const PACKET_CAP = 900;
  const packets = [];
  for (const v of edgeViews.values()) {
    const n = Math.min(6, 1 + Math.round((v.edge.volume ?? 0.5) * 4));
    for (let i = 0; i < n; i++) {
      if (packets.length >= PACKET_CAP) break;
      packets.push({ v, phase: i / n });
    }
  }

  const packetGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const packetMesh = new THREE.InstancedMesh(
    packetGeo,
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: false }),
    Math.max(1, packets.length)
  );
  packetMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  packetMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, packets.length) * 3), 3);
  packetMesh.frustumCulled = false;
  scene.add(packetMesh);

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _colNormal = new THREE.Color(C.ink);
  const _colHot = new THREE.Color(C.liveHi);

  /* ==========================================================================
     5. chrome — top strip, sidebar, narrative, hint bar
     ========================================================================== */

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  (function topbar() {
    const el = root.querySelector('#topbar');
    const m = DATA.meta;
    let html = `<div class="stat repo"><span class="k">Repository</span><span class="v">${esc(m.repo)}${m.branch ? ` <span class="branch">· ${esc(m.branch)}</span>` : ''}</span></div>`;
    for (const s of (DATA.stats || [])) {
      html += `<div class="stat"><span class="k">${esc(s.label)}</span><span class="v">${esc(s.value)}</span></div>`;
    }
    html += `<div class="stat spacer"></div>`;
    el.innerHTML = html;
  })();

  (function sidebar() {
    const el = root.querySelector('#sidebar');
    let html = '';
    for (const g of groupsOrdered) {
      const members = DATA.nodes.filter(n => n.group === g.id);
      if (!members.length) continue;
      html += `<div class="grp-head">${esc(g.label)}</div>`;
      if (g.note) html += `<div class="grp-note">${esc(g.note)}</div>`;
      for (const n of members) {
        const child = (n.kind === 'model' || n.kind === 'library') ? ' child' : '';
        const st = n.status && n.status !== 'active' ? ' ' + n.status : '';
        html += `<div class="nrow${child}${st}" data-node="${esc(n.id)}" title="${esc(n.summary)}">`
              + `<span class="glyph">${esc(KIND[n.kind].glyph)}</span>`
              + `<span class="lbl">${esc(n.label)}</span>`
              + `<span class="deg">${degree.get(n.id)}</span></div>`;
      }
    }
    el.innerHTML = html;
    el.addEventListener('mouseover', ev => {
      const row = ev.target.closest('.nrow');
      if (row) setHover({ type: 'node', id: row.dataset.node }, null);
    });
    el.addEventListener('mouseleave', () => setHover(null, null));
    el.addEventListener('click', ev => {
      const row = ev.target.closest('.nrow');
      if (row) { focusNode(row.dataset.node); openInspector(row.dataset.node); }
    });
  })();

  const glossary = new Map((DATA.narrative.glossary || []).map(g => [g.term.toLowerCase(), g.definition]));

  function inline(text) {
    let s = esc(text);
    s = s.replace(/\[\[([^\]|]+)\|([a-z][a-z0-9_]*)\]\]/g,
      (_, label, id) => nodeById.has(id)
        ? `<span class="nref" data-node="${id}">${label}</span>`
        : label);
    s = s.replace(/\{\{([^}]+)\}\}/g, (_, term) => {
      const def = glossary.get(term.toLowerCase());
      return def ? `<span class="gref" title="${esc(def)}">${term}</span>` : term;
    });
    return s;
  }

  (function narrative() {
    const tabsEl = root.querySelector('#tabs');
    const bodyEl = root.querySelector('#narrbody');
    const tabs = DATA.narrative.tabs;

    tabsEl.innerHTML = tabs.map((t, i) =>
      `<button data-tab="${esc(t.id)}" class="${i === 0 ? 'on' : ''}">${esc(t.label)}</button>`).join('');

    const render = tab => {
      bodyEl.innerHTML = tab.blocks.map(b => {
        if (b.type === 'rule') return `<div class="n-rule"></div>`;
        if (b.type === 'h')    return `<div class="n-h">${inline(b.text)}</div>`;
        if (b.type === 'note') return `<div class="n-note">${inline(b.text)}</div>`;
        if (b.type === 'code') return `<div class="n-code">${esc(b.text)}</div>`;
        return `<div class="n-p">${inline(b.text)}</div>`;
      }).join('');
      bodyEl.scrollTop = 0;
    };
    render(tabs[0]);

    tabsEl.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      [...tabsEl.children].forEach(x => x.classList.toggle('on', x === b));
      render(tabs.find(t => t.id === b.dataset.tab));
    });

    bodyEl.addEventListener('mouseover', ev => {
      const r = ev.target.closest('.nref');
      if (r) setHover({ type: 'node', id: r.dataset.node }, null);
    });
    bodyEl.addEventListener('mouseout', ev => {
      if (ev.target.closest('.nref')) setHover(null, null);
    });
    bodyEl.addEventListener('click', ev => {
      const r = ev.target.closest('.nref');
      if (r) { focusNode(r.dataset.node); openInspector(r.dataset.node); }
    });
  })();

  (function botbar() {
    root.querySelector('#botbar').innerHTML =
        `<span><kbd>drag</kbd>pan</span>`
      + `<span><kbd>scroll</kbd>zoom</span>`
      + `<span><kbd>Q</kbd><kbd>E</kbd>rotate</span>`
      + `<span><kbd>F</kbd>fit</span>`
      + `<span><kbd>L</kbd>labels</span>`
      + `<span><kbd>hover</kbd>read a block or a line</span>`
      + `<span class="right">${DATA.nodes.length} nodes · ${DATA.edges.length} connections`
      + `${DATA.meta.generated ? ' · ' + esc(DATA.meta.generated) : ''}</span>`;
  })();

  /* ---------- floating labels ---------------------------------------------- */

  const labelEls = new Map();
  for (const n of DATA.nodes) {
    const d = document.createElement('div');
    d.className = 'nlabel';
    d.dataset.node = n.id;   // lets a test harness match a label to its block
    d.textContent = n.label;
    labelsEl.appendChild(d);
    labelEls.set(n.id, d);
  }
  let labelsOn = true;

  /* ==========================================================================
     6. interaction
     ========================================================================== */

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hover = null;          // {type:'node'|'edge', id}
  let selected = null;
  let mouseXY = { x: 0, y: 0 };

  function relatedEdges(nodeId) {
    const out = [];
    for (const v of edgeViews.values()) if (v.edge.from === nodeId || v.edge.to === nodeId) out.push(v);
    return out;
  }

  function paintHighlight() {
    const hotNodes = new Set();
    const hotEdges = new Set();

    if (hover?.type === 'node') {
      hotNodes.add(hover.id);
      for (const v of relatedEdges(hover.id)) {
        hotEdges.add(v.edge.id);
        hotNodes.add(v.edge.from === hover.id ? v.edge.to : v.edge.from);
      }
    } else if (hover?.type === 'edge') {
      const v = edgeViews.get(hover.id);
      if (v) { hotEdges.add(v.edge.id); hotNodes.add(v.edge.from); hotNodes.add(v.edge.to); }
    }
    if (selected) {
      hotNodes.add(selected);
      for (const v of relatedEdges(selected)) hotEdges.add(v.edge.id);
    }

    const primary = hover?.type === 'node' ? hover.id : selected;

    for (const [id, view] of nodeViews) {
      const isPrimary = id === primary;
      const isHot = hotNodes.has(id);
      const col = isPrimary ? C.live : (isHot ? C.liveHi : C.ink);
      for (const m of view.outlineMats) {
        m.color.setHex(col);
        m.opacity = isHot ? 1 : (hotNodes.size ? 0.42 : 0.95);
      }
      const el = labelEls.get(id);
      if (el) el.classList.toggle('hot', isHot);
    }

    for (const v of edgeViews.values()) {
      const isHot = hotEdges.has(v.edge.id);
      v.boost = isHot ? 1 : 0;
      for (const m of v.mats) {
        m.color.setHex(isHot ? C.live : C.ink);
        m.opacity = isHot ? 1 : (hotEdges.size ? 0.26 : v.baseOpacity);
      }
    }

    root.querySelectorAll('#sidebar .nrow').forEach(r => {
      r.classList.toggle('hot', hotNodes.has(r.dataset.node));
      r.classList.toggle('sel', r.dataset.node === selected);
      r.classList.toggle('dim', hotNodes.size > 0 && !hotNodes.has(r.dataset.node));
    });
    root.querySelectorAll('#narrbody .nref').forEach(r => {
      r.classList.toggle('hot', hotNodes.has(r.dataset.node));
    });
  }

  function cardHTML(h) {
    if (h.type === 'node') {
      const n = nodeById.get(h.id);
      if (!n) return '';
      const g = groupById.get(n.group);
      let s = `<div class="c-kind"><span>${esc(n.kind)}</span><span>${esc(g ? g.label : '')}</span></div>`;
      s += `<div class="c-title">${esc(n.label)}</div>`;
      s += `<div class="c-sum">${esc(n.summary)}</div>`;
      s += `<div class="c-det">${esc(n.detail)}</div>`;
      if (n.metrics?.length) {
        s += `<div class="c-mets">` + n.metrics.map(m =>
          `<div><b>${esc(m.value)}</b><i>${esc(m.label)}</i></div>`).join('') + `</div>`;
      }
      if (n.paths?.length) {
        s += `<div class="c-sec">Source</div><div class="c-paths">`
           + n.paths.map(p => `<div>${esc(p)}</div>`).join('') + `</div>`;
      }
      if (n.tech?.length) {
        s += `<div class="c-sec">Built with</div><div class="c-chips">`
           + n.tech.map(t => `<span>${esc(t)}</span>`).join('') + `</div>`;
      }
      const rel = relatedEdges(n.id);
      s += `<div class="c-sec">${rel.length} connection${rel.length === 1 ? '' : 's'}${n.status && n.status !== 'active' ? ' · ' + esc(n.status) : ''}</div>`;
      return s;
    }
    const v = edgeViews.get(h.id);
    if (!v) return '';
    const e = v.edge;
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    let s = `<div class="c-kind"><span>${esc(e.kind)}</span><span>connection</span></div>`;
    const arrow = e.bidirectional ? '&lt;-&gt;' : '-&gt;';
    s += `<div class="c-flow"><b>${esc(a.label)}</b><em>${arrow}</em><b>${esc(b.label)}</b></div>`;
    s += `<div class="c-title" style="font-size:10px">${esc(e.label)}</div>`;
    s += `<div class="c-sec">Carries</div><div class="c-code">${esc(e.payload)}</div>`;
    s += `<div class="c-det" style="margin-top:6px">${esc(e.detail)}</div>`;
    s += `<div class="c-sec">Traffic ${Math.round((e.volume ?? 0.5) * 100)}%</div>`;
    return s;
  }

  function placeCard() {
    const w = 268, pad = 14;
    const r = stage.getBoundingClientRect();
    let x = mouseXY.x - r.left + 18;
    let y = mouseXY.y - r.top + 14;
    if (x + w + pad > r.width) x = mouseXY.x - r.left - w - 18;
    const h = cardEl.offsetHeight || 200;
    if (y + h + pad > r.height) y = Math.max(pad, r.height - h - pad);
    cardEl.style.left = x + 'px';
    cardEl.style.top = y + 'px';
  }

  function setHover(h, ev) {
    const same = (hover && h && hover.type === h.type && hover.id === h.id) || (!hover && !h);
    if (ev) mouseXY = { x: ev.clientX, y: ev.clientY };
    if (same) { if (h) placeCard(); return; }
    hover = h;
    if (h) {
      cardEl.innerHTML = cardHTML(h);
      cardEl.classList.add('on');
      placeCard();
    } else {
      cardEl.classList.remove('on');
    }
    paintHighlight();
  }

  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hitN = raycaster.intersectObjects(pickNodes, false);
    if (hitN.length) return { type: 'node', id: hitN[0].object.userData.nodeId };
    const hitE = raycaster.intersectObjects(pickEdges, false);
    if (hitE.length) return { type: 'edge', id: hitE[0].object.userData.edgeId };
    return null;
  }

  /* ---------- pointer: pan / hover / select --------------------------------- */

  let dragging = false, dragged = false, last = null;

  stage.addEventListener('pointerdown', ev => {
    dragging = true; dragged = false;
    last = { x: ev.clientX, y: ev.clientY };
    stage.classList.add('dragging');
    stage.setPointerCapture(ev.pointerId);
  });

  stage.addEventListener('pointermove', ev => {
    mouseXY = { x: ev.clientX, y: ev.clientY };
    if (dragging && last) {
      const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
      last = { x: ev.clientX, y: ev.clientY };
      const { halfH } = frustumFor(cam.zoom);
      const k = (halfH * 2) / (stage.clientHeight || 1);
      // screen-right and screen-up-on-the-ground, in world space
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
      const fwd = new THREE.Vector3().subVectors(cam.target, camera.position).setY(0).normalize();
      // 1 px of vertical screen motion covers more ground than 1 px horizontal,
      // because the floor is seen at the isometric elevation angle
      const TILT = 1 / Math.sin(Math.atan(1 / Math.SQRT2));
      cam.targetGoal.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k * TILT);
      cam.target.copy(cam.targetGoal);
      return;
    }
    setHover(pick(ev), ev);
  });

  stage.addEventListener('pointerup', ev => {
    dragging = false; last = null;
    stage.classList.remove('dragging');
    try { stage.releasePointerCapture(ev.pointerId); } catch (_) {}
    if (!dragged) {
      const h = pick(ev);
      if (h?.type === 'node') {
        if (selected === h.id) { closeInspector(); }
        else { selected = h.id; focusNode(h.id); openInspector(h.id); }
      } else if (!h) { closeInspector(); }
      paintHighlight();
    }
  });

  stage.addEventListener('pointerleave', () => { setHover(null, null); });

  stage.addEventListener('wheel', ev => {
    ev.preventDefault();
    cam.zoomGoal = THREE.MathUtils.clamp(cam.zoomGoal * (ev.deltaY > 0 ? 0.9 : 1.111), 0.3, 7);
  }, { passive: false });

  function focusNode(id) {
    if (!id) return;
    const v = nodeViews.get(id);
    if (!v) return;
    cam.targetGoal.set(v.node._x, 0, v.node._z);
    cam.zoomGoal = Math.max(cam.zoomGoal, 1.9);
    selected = id;
    paintHighlight();
  }

  /* Fit every block into the viewport by measuring the drawing in CAMERA space.
     Measuring in world space would be wrong: an isometric view of a wide, shallow
     graph is much taller on screen than its world depth suggests. */
  function fitAll() {
    const v = new THREE.Vector3();
    const keepTarget = cam.target.clone(), keepZoom = cam.zoom;
    cam.target.set(0, 0, 0);
    cam.zoom = 1;
    applyCamera();
    camera.updateMatrixWorld(true);
    const inv = camera.matrixWorldInverse;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const view of nodeViews.values()) {
      const y0 = view.group.position.y;
      for (const dx of [-view.fx / 2, view.fx / 2])
        for (const dz of [-view.fz / 2, view.fz / 2])
          for (const dy of [0, view.hy]) {
            v.set(view.node._x + dx, y0 + dy, view.node._z + dz).applyMatrix4(inv);
            if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
          }
    }
    cam.target.copy(keepTarget); cam.zoom = keepZoom;   // resume from where we were
    if (!isFinite(minX)) { cam.targetGoal.set(0, 0, 0); cam.zoomGoal = 1; return; }

    // recentre: shift the look-at point by the camera-space offset of the content
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    cam.targetGoal.set(0, 0, 0)
      .addScaledVector(right, (minX + maxX) / 2)
      .addScaledVector(up, (minY + maxY) / 2);

    const { halfW, halfH } = frustumFor(1);
    const needW = Math.max((maxX - minX) / 2, 0.001);
    const needH = Math.max((maxY - minY) / 2, 0.001);
    const PAD = 0.94;                       // breathing room + label overhang
    cam.zoomGoal = THREE.MathUtils.clamp(Math.min(halfW / needW, halfH / needH) * PAD, 0.3, 7);

    selected = null;
    paintHighlight();
  }

  window.addEventListener('keydown', ev => {
    const k = ev.key.toLowerCase();
    if (k === 'q') { cam.yawStep--; cam.yawGoal = cam.yawStep * Math.PI / 2; }
    else if (k === 'e') { cam.yawStep++; cam.yawGoal = cam.yawStep * Math.PI / 2; }
    else if (k === 'f') fitAll();
    else if (k === 'l') { labelsOn = !labelsOn; }
    else if (k === 'escape') { setHover(null, null); closeInspector(); }
  }, { signal });

  /* ==========================================================================
     7. loop
     ========================================================================== */

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden && alive; if (running) tick(); }, { signal });

  const proj = new THREE.Vector3();
  let t0 = performance.now(), clock = 0;

  /* Labels are HTML, so they stay crisp — but they will happily pile on top of
     each other. Draw order is by connection count (the busiest blocks earn their
     name first), then anything that would collide with an already-placed label is
     dropped for this frame. Hovered and selected blocks always win. */

  const labelOrder = DATA.nodes
    .map(n => n.id)
    .sort((a, b) => degree.get(b) - degree.get(a) || a.localeCompare(b));

  const labelSize = new Map();   // measured once laid out; the text never changes
  const placedRects = [];

  /** Pixels between a block's top corner and the bottom of its label. */
  const LABEL_GAP = 7;

  /* Measure only what the browser has actually laid out. Falling back to a
     guess and latching it would freeze every label at the same made-up width,
     which quietly breaks the collision test for the rest of the session. */
  function measureLabels() {
    if (labelSize.size === labelEls.size) return;
    for (const [id, el] of labelEls) {
      if (labelSize.has(id)) continue;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w > 0 && h > 0) labelSize.set(id, [w, h]);
    }
  }

  function updateLabels() {
    // The canvas is the frame of reference, not its container: they agree only
    // while the renderer keeps the canvas sized to fit, and a bug there should
    // show up as a misplaced label rather than as silently wrong coordinates.
    const W = renderer.domElement.clientWidth || stage.clientWidth;
    const H = renderer.domElement.clientHeight || stage.clientHeight;
    const showAll = labelsOn && cam.zoom > 0.5;

    measureLabels();

    placedRects.length = 0;
    const priority = new Set();
    if (hover?.type === 'node') priority.add(hover.id);
    if (hover?.type === 'edge') {
      const ev = edgeViews.get(hover.id);
      if (ev) { priority.add(ev.edge.from); priority.add(ev.edge.to); }
    }
    if (selected) priority.add(selected);

    const pass = [...priority, ...labelOrder.filter(id => !priority.has(id))];

    for (const id of pass) {
      const el = labelEls.get(id);
      const v = nodeViews.get(id);
      const forced = priority.has(id);
      if (!showAll && !forced) { el.classList.add('hidden'); continue; }

      proj.set(v.node._x, v.topY, v.node._z).project(camera);
      if (proj.z > 1) { el.classList.add('hidden'); continue; }
      const x = (proj.x * 0.5 + 0.5) * W;
      const y = (-proj.y * 0.5 + 0.5) * H;
      if (x < -60 || y < -20 || x > W + 60 || y > H + 20) { el.classList.add('hidden'); continue; }

      // Anchored by its bottom edge, a fixed number of pixels above the block,
      // so the gap reads the same at every zoom level.
      const [lw, lh] = labelSize.get(id) || [40, 10];
      const top = y - LABEL_GAP - lh;
      const rect = [x - lw / 2 - 2, top - 1, x + lw / 2 + 2, top + lh + 1];
      if (!forced) {
        let clash = false;
        for (const r of placedRects) {
          if (rect[0] < r[2] && rect[2] > r[0] && rect[1] < r[3] && rect[3] > r[1]) { clash = true; break; }
        }
        if (clash) { el.classList.add('hidden'); continue; }
      }
      placedRects.push(rect);
      el.classList.remove('hidden');
      el.style.transform = `translate(-50%,-100%) translate(${x.toFixed(1)}px,${(y - LABEL_GAP).toFixed(1)}px)`;
    }
  }

  function tick() {
    if (!running || !alive) return;
    rafId = requestAnimationFrame(tick);

    const now = performance.now();
    const dt = Math.min(0.05, (now - t0) / 1000);
    t0 = now; clock += dt;

    // camera easing
    cam.zoom += (cam.zoomGoal - cam.zoom) * Math.min(1, dt * 9);
    cam.yawAngle += (cam.yawGoal - cam.yawAngle) * Math.min(1, dt * 7);
    cam.target.lerp(cam.targetGoal, Math.min(1, dt * 7));
    applyCamera();

    // packets
    let i = 0;
    for (const p of packets) {
      const v = p.v;
      const sp = v.speed * (1 + v.boost * 2.2) / Math.max(1, v.total * 0.32);
      p.phase = (p.phase + sp * dt) % 1;
      const pos = pointOnEdge(v, p.phase);
      const scl = v.boost ? 1.7 : 1;
      _m.compose(pos, _q, _s.set(scl, scl, scl));
      packetMesh.setMatrixAt(i, _m);
      const c = v.boost ? _colHot : _colNormal;
      packetMesh.instanceColor.setXYZ(i, c.r, c.g, c.b);
      i++;
    }
    if (packets.length) {
      packetMesh.instanceMatrix.needsUpdate = true;
      packetMesh.instanceColor.needsUpdate = true;
    }

    updateLabels();
    if (cardEl.classList.contains('on')) placeCard();
    renderer.render(scene, camera);
    frames++; window.__bpFrames = (window.__bpFrames || 0) + 1;
  }


  /* ==========================================================================
     8. the inspector — everything about one block, on click
     ========================================================================== */

  const inspKind = inspEl.querySelector('.kind');
  const inspTitle = inspEl.querySelector('h2');
  const inspSum = inspEl.querySelector('.sum');
  const inspBody = root.querySelector('#insp-body');

  inspEl.querySelector('.close').addEventListener('click', () => closeInspector(), { signal });

  function section(label, html) {
    return `<div class="isec">${esc(label)}</div>${html}`;
  }

  function inspectorHTML(n) {
    let s = '';
    if (n.detail) s += section('What it is', `<div class="iprose">${esc(n.detail)}</div>`);

    if (n.metrics?.length) {
      s += section('At a glance', `<div class="imets">` + n.metrics.map(m =>
        `<div><b>${esc(m.value)}</b><i>${esc(m.label)}</i></div>`).join('') + `</div>`);
    }

    const d = n.details || {};
    if (d.facts?.length) {
      s += section('Facts', `<table class="ifacts">` + d.facts.map(f =>
        `<tr><td class="k">${esc(f.label)}</td><td class="v">${esc(f.value)}</td></tr>`).join('') + `</table>`);
    }
    for (const l of (d.lists || [])) {
      s += section(l.label, `<div class="ichips">` +
        l.items.map(x => `<span class="mono">${esc(x)}</span>`).join('') + `</div>`);
    }
    if (d.env?.length) {
      s += section('Environment', `<div class="ichips">` +
        d.env.map(v => `<span class="mono">${esc(v)}</span>`).join('') + `</div>`);
    }
    if (n.tech?.length) {
      s += section('Built with', `<div class="ichips">` +
        n.tech.map(t => `<span>${esc(t)}</span>`).join('') + `</div>`);
    }
    if (n.paths?.length) {
      s += section('Source', `<div class="ipaths">` +
        n.paths.map(p => `<div>${esc(p)}</div>`).join('') + `</div>`);
    }
    if (d.links?.length) {
      s += section('Links', `<div class="ilinks">` + d.links.map(l =>
        `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label)}</a>`).join('') + `</div>`);
    }

    const outs = [], ins = [];
    for (const v of edgeViews.values()) {
      if (v.edge.from === n.id) outs.push(v.edge);
      else if (v.edge.to === n.id) ins.push(v.edge);
    }
    const wire = (e, dir) => {
      const peer = nodeById.get(dir === 'out' ? e.to : e.from);
      return `<button class="iwire" data-node="${esc(peer.id)}" type="button">`
           + `<span class="dir">${dir === 'out' ? '→ to' : '← from'} · ${esc(e.kind)}</span>`
           + `<span class="peer">${esc(peer.label)}</span>`
           + `<span class="pay">${esc(e.payload)}</span></button>`;
    };
    if (outs.length) s += section(`Sends (${outs.length})`, outs.map(e => wire(e, 'out')).join(''));
    if (ins.length) s += section(`Receives (${ins.length})`, ins.map(e => wire(e, 'in')).join(''));

    return s;
  }

  function openInspector(id) {
    const n = nodeById.get(id);
    if (!n) return;
    const g = groupById.get(n.group);
    inspKind.textContent = `${n.kind} · ${g ? g.label : ''}`;
    inspTitle.textContent = n.label;
    inspSum.textContent = n.summary || '';
    inspBody.innerHTML = inspectorHTML(n);
    inspBody.scrollTop = 0;
    inspEl.classList.add('on');
    if (opts.onSelect) opts.onSelect(id);
  }

  function closeInspector() {
    inspEl.classList.remove('on');
    selected = null;
    paintHighlight();
  }

  inspBody.addEventListener('mouseover', ev => {
    const w = ev.target.closest('.iwire');
    if (w) setHover({ type: 'node', id: w.dataset.node }, null);
  }, { signal });
  inspBody.addEventListener('mouseout', ev => {
    if (ev.target.closest('.iwire')) setHover(null, null);
  }, { signal });
  inspBody.addEventListener('click', ev => {
    const w = ev.target.closest('.iwire');
    if (w) { focusNode(w.dataset.node); openInspector(w.dataset.node); }
  }, { signal });

  /* ==========================================================================
     9. bootstrap + teardown
     ========================================================================== */

  resize();
  if (opts.camera) {
    cam.targetGoal.set(opts.camera.x || 0, 0, opts.camera.z || 0);
    cam.target.copy(cam.targetGoal);
    cam.zoom = cam.zoomGoal = opts.camera.zoom || 1;
    cam.yawStep = opts.camera.yawStep || 0;
    cam.yawAngle = cam.yawGoal = cam.yawStep * Math.PI / 2;
    applyCamera();
  } else {
    fitAll();
  }
  paintHighlight();
  tick();

  /* Free the GPU. A webview that reloads a file forty times while you write it
     will otherwise leak every buffer and texture of every previous draw. */
  function dispose() {
    alive = false;
    running = false;
    cancelAnimationFrame(rafId);
    ac.abort();
    _ro.disconnect();
    scene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach(x => { x.map?.dispose(); x.dispose(); });
      else if (m) { m.map?.dispose(); m.dispose(); }
    });
    for (const t of texCache.values()) t.dispose();
    texCache.clear();
    renderer.dispose();
    renderer.forceContextLoss?.();
    root.innerHTML = '';
  }

  return {
    dispose,
    data: DATA,
    camera,
    renderer,
    cam,          // the camera's goal state, so a harness can drive zoom/yaw
    problems,
    nodeViews,
    edgeViews,
    focus: focusNode,
    fit: fitAll,
    inspect: openInspector,
    get frames() { return frames; },
    getCamera: () => ({
      x: cam.targetGoal.x, z: cam.targetGoal.z,
      zoom: cam.zoomGoal, yawStep: cam.yawStep,
    }),
    // used by the automated checks
    hoverAt(id, type = 'node') { setHover({ type, id }, null); return cardEl.textContent; },
  };
}
