/* ==========================================================================
   validate.mjs — dependency-free checker for codeviz.json v1.0
   ---------------------------------------------------------------------------
   Usage:  node scripts/validate.mjs path/to/my-repo.codeviz.json
   Exit 0 = valid (warnings may still print), exit 1 = invalid.

   This mirrors schema/codeviz.schema.json plus the cross-reference and
   quality rules a JSON Schema cannot express. Run it before you build;
   it catches the mistakes an LLM actually makes.
   ========================================================================== */

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NODE_KINDS = ['entrypoint', 'service', 'store', 'queue', 'model', 'library', 'external', 'job'];
const EDGE_KINDS = ['data', 'call', 'event', 'read', 'write', 'spawn'];
const BLOCK_TYPES = ['h', 'p', 'note', 'code', 'rule'];
const STATUSES = ['active', 'dormant', 'planned'];
const SLUG = /^[a-z][a-z0-9_]{1,47}$/;

export function validate(d) {
  const errors = [];
  const warns = [];
  const E = m => errors.push(m);
  const W = m => warns.push(m);

  const str = (v, path, min, max) => {
    if (typeof v !== 'string') { E(`${path}: must be a string`); return false; }
    if (min != null && v.trim().length < min) { E(`${path}: too short (min ${min} chars)`); return false; }
    if (max != null && v.length > max) { E(`${path}: too long (${v.length} > ${max} chars)`); return false; }
    return true;
  };

  if (!d || typeof d !== 'object') return { errors: ['root: not an object'], warns };
  if (d.codeviz !== '1.0') E(`codeviz: must be "1.0", got ${JSON.stringify(d.codeviz)}`);

  /* meta ------------------------------------------------------------------ */
  const m = d.meta;
  if (!m || typeof m !== 'object') E('meta: missing');
  else {
    str(m.repo, 'meta.repo', 1, 60);
    str(m.title, 'meta.title', 1, 60);
    str(m.tagline, 'meta.tagline', 1, 160);
    if (m.branch != null) str(m.branch, 'meta.branch', 0, 40);
    if (/\b(powerful|seamless|robust|cutting[- ]edge|revolutionary|state[- ]of[- ]the[- ]art)\b/i.test(m.tagline || ''))
      W('meta.tagline: reads like marketing copy — say what it does instead');
  }

  /* stats ----------------------------------------------------------------- */
  if (d.stats != null) {
    if (!Array.isArray(d.stats)) E('stats: must be an array');
    else {
      if (d.stats.length > 6) E(`stats: at most 6 (got ${d.stats.length})`);
      d.stats.forEach((s, i) => {
        str(s?.label, `stats[${i}].label`, 1, 24);
        str(s?.value, `stats[${i}].value`, 1, 34);
      });
    }
  }

  /* groups ---------------------------------------------------------------- */
  const groupIds = new Set();
  if (!Array.isArray(d.groups) || d.groups.length < 1) E('groups: need at least 1');
  else {
    if (d.groups.length > 8) E(`groups: at most 8 (got ${d.groups.length})`);
    d.groups.forEach((g, i) => {
      if (!SLUG.test(g?.id || '')) E(`groups[${i}].id: not lower_snake_case`);
      else if (groupIds.has(g.id)) E(`groups[${i}].id: duplicate "${g.id}"`);
      else groupIds.add(g.id);
      str(g?.label, `groups[${i}].label`, 1, 40);
    });
  }

  /* nodes ----------------------------------------------------------------- */
  const nodeIds = new Set();
  if (!Array.isArray(d.nodes) || d.nodes.length < 4) E('nodes: need at least 4');
  else {
    if (d.nodes.length > 60) E(`nodes: at most 60 (got ${d.nodes.length})`);
    if (d.nodes.length < 15) W(`nodes: only ${d.nodes.length} — under 15 the drawing looks trivial; split a subsystem or two`);
    if (d.nodes.length > 40) W(`nodes: ${d.nodes.length} — over 40 the drawing turns to soup; collapse leaf modules into parents`);

    d.nodes.forEach((n, i) => {
      const p = `nodes[${i}]${n?.id ? `(${n.id})` : ''}`;
      if (!SLUG.test(n?.id || '')) E(`${p}.id: not lower_snake_case`);
      else if (nodeIds.has(n.id)) E(`${p}.id: duplicate`);
      else nodeIds.add(n.id);
      str(n?.label, `${p}.label`, 1, 34);
      if (!groupIds.has(n?.group)) E(`${p}.group: "${n?.group}" is not a declared group`);
      if (!NODE_KINDS.includes(n?.kind)) E(`${p}.kind: "${n?.kind}" not one of ${NODE_KINDS.join('|')}`);
      str(n?.summary, `${p}.summary`, 1, 90);
      str(n?.detail, `${p}.detail`, 20, 600);
      if (n?.weight != null && (typeof n.weight !== 'number' || n.weight < 0.5 || n.weight > 2))
        E(`${p}.weight: must be a number in [0.5, 2]`);
      if (n?.status != null && !STATUSES.includes(n.status)) E(`${p}.status: not one of ${STATUSES.join('|')}`);
      if (n?.pos != null) {
        if (!Array.isArray(n.pos) || n.pos.length !== 2 || !n.pos.every(Number.isInteger))
          E(`${p}.pos: must be [int, int]`);
      }
      if (n?.paths != null && !Array.isArray(n.paths)) E(`${p}.paths: must be an array`);
      if (n?.tech != null && !Array.isArray(n.tech)) E(`${p}.tech: must be an array`);
      if (n?.detail && n.detail.trim().split(/[.!?]\s/).length < 2)
        W(`${p}.detail: reads as a single sentence — the hover card wants 2-4`);
    });
  }

  /* edges ----------------------------------------------------------------- */
  const edgeIds = new Set();
  const pairSeen = new Set();
  const touched = new Set();
  if (!Array.isArray(d.edges) || d.edges.length < 1) E('edges: need at least 1');
  else {
    if (d.edges.length > 160) E(`edges: at most 160 (got ${d.edges.length})`);
    d.edges.forEach((e, i) => {
      const p = `edges[${i}]${e?.id ? `(${e.id})` : ''}`;
      if (!SLUG.test(e?.id || '')) E(`${p}.id: not lower_snake_case`);
      else if (edgeIds.has(e.id)) E(`${p}.id: duplicate`);
      else edgeIds.add(e.id);
      if (!nodeIds.has(e?.from)) E(`${p}.from: "${e?.from}" is not a declared node`);
      if (!nodeIds.has(e?.to)) E(`${p}.to: "${e?.to}" is not a declared node`);
      if (e?.from && e.from === e?.to) E(`${p}: self-loop`);
      if (!EDGE_KINDS.includes(e?.kind)) E(`${p}.kind: "${e?.kind}" not one of ${EDGE_KINDS.join('|')}`);
      str(e?.label, `${p}.label`, 1, 40);
      str(e?.payload, `${p}.payload`, 1, 160);
      str(e?.detail, `${p}.detail`, 20, 400);
      if (e?.volume != null && (typeof e.volume !== 'number' || e.volume < 0 || e.volume > 1))
        E(`${p}.volume: must be a number in [0, 1]`);
      const key = `${e?.from}>${e?.to}`;
      if (pairSeen.has(key)) W(`${p}: a second edge already runs ${key} — consider merging them`);
      pairSeen.add(key);
      touched.add(e?.from); touched.add(e?.to);
      if (typeof e?.payload === 'string' && /^(data|info|stuff|things|state|results?)$/i.test(e.payload.trim()))
        W(`${p}.payload: "${e.payload}" is not concrete — name a type, function, table, or route`);
    });
  }

  for (const id of nodeIds) if (!touched.has(id)) W(`nodes(${id}): no edges touch it — either wire it up or drop it`);

  /* narrative -------------------------------------------------------------- */
  const nar = d.narrative;
  if (!nar || !Array.isArray(nar.tabs) || nar.tabs.length < 1) E('narrative.tabs: need at least 1');
  else {
    const terms = new Set((nar.glossary || []).map(g => String(g.term || '').toLowerCase()));
    (nar.glossary || []).forEach((g, i) => {
      str(g?.term, `narrative.glossary[${i}].term`, 1, 60);
      str(g?.definition, `narrative.glossary[${i}].definition`, 1, 400);
    });
    let refCount = 0;
    nar.tabs.forEach((t, ti) => {
      const p = `narrative.tabs[${ti}]`;
      if (!SLUG.test(t?.id || '')) E(`${p}.id: not lower_snake_case`);
      str(t?.label, `${p}.label`, 1, 24);
      if (!Array.isArray(t?.blocks) || !t.blocks.length) { E(`${p}.blocks: empty`); return; }
      t.blocks.forEach((b, bi) => {
        const bp = `${p}.blocks[${bi}]`;
        if (!BLOCK_TYPES.includes(b?.type)) E(`${bp}.type: "${b?.type}" not one of ${BLOCK_TYPES.join('|')}`);
        if (b?.type !== 'rule') str(b?.text, `${bp}.text`, 1, 2000);
        const text = String(b?.text || '');
        for (const mm of text.matchAll(/\[\[([^\]|]*)\|([^\]]*)\]\]/g)) {
          refCount++;
          if (!nodeIds.has(mm[2])) E(`${bp}: [[…|${mm[2]}]] points at a node that does not exist`);
          if (!mm[1].trim()) E(`${bp}: [[…|${mm[2]}]] has empty display text`);
        }
        for (const mm of text.matchAll(/\{\{([^}]*)\}\}/g)) {
          if (!terms.has(mm[1].trim().toLowerCase())) E(`${bp}: {{${mm[1]}}} is not in narrative.glossary`);
        }
        if (/<[a-z/]/i.test(text)) W(`${bp}.text: contains raw HTML — it will be escaped, not rendered`);
      });
    });
    if (refCount < 3) W(`narrative: only ${refCount} [[…|node_id]] links — the panel and the diagram should point at each other`);
  }

  return { errors, warns };
}

/* ---------- CLI ----------------------------------------------------------- */

let isMain = false;
try { isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
catch { isMain = false; }
if (isMain) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/validate.mjs <codeviz.json>'); process.exit(2); }
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`\x1b[31mnot valid JSON:\x1b[0m ${e.message}`); process.exit(1); }

  const { errors, warns } = validate(data);
  for (const w of warns) console.log(`\x1b[33mwarn \x1b[0m ${w}`);
  for (const e of errors) console.log(`\x1b[31merror\x1b[0m ${e}`);
  if (errors.length) {
    console.log(`\n\x1b[31m${errors.length} error(s)\x1b[0m, ${warns.length} warning(s) — not renderable`);
    process.exit(1);
  }
  console.log(`\n\x1b[32mvalid\x1b[0m — ${data.nodes.length} nodes, ${data.edges.length} edges, ${warns.length} warning(s)`);
}
