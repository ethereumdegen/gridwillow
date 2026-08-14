/* ==========================================================================
   build.mjs — bake a codeviz.json into one self-contained HTML file
   ---------------------------------------------------------------------------
   Usage:  node scripts/build.mjs <codeviz.json> [out.html] [--force]

   The output has no external references at all: three.js, the stylesheet, the
   renderer and the data are all inlined. It opens straight off disk with
   file:// — no server, no network, no npm install.
   ========================================================================== */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { validate } from './validate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(ROOT, p), 'utf8');

const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter(a => !a.startsWith('--'));
const dataPath = positional[0];

if (!dataPath) {
  console.error('usage: node scripts/build.mjs <codeviz.json> [out.html] [--force]');
  process.exit(2);
}

let data;
try { data = JSON.parse(readFileSync(dataPath, 'utf8')); }
catch (e) { console.error(`\x1b[31mnot valid JSON:\x1b[0m ${e.message}`); process.exit(1); }

const { errors, warns } = validate(data);
for (const w of warns) console.log(`\x1b[33mwarn \x1b[0m ${w}`);
for (const e of errors) console.log(`\x1b[31merror\x1b[0m ${e}`);
if (errors.length && !force) {
  console.error(`\n${errors.length} error(s). Fix them, or pass --force to build anyway.`);
  process.exit(1);
}

const outPath = positional[1]
  || resolve(dirname(dataPath), basename(dataPath).replace(/\.codeviz\.json$|\.json$/, '') + '.blueprint.html');

const tpl   = read('template/index.html');
const css   = read('template/style.css');
const js    = read('template/renderer.js');
const three = read('vendor/three.module.min.js');

// A `</script` sequence anywhere inside an inline script would close the tag
// early. It can only ever occur inside a JS string literal, so escaping the
// slash is always safe.
const safeJs = s => s.replace(/<\/script/gi, '<\\/script');
const safeJson = s => s.replace(/<\/script/gi, '<\\u002fscript');

const threeDataUrl = 'data:text/javascript;base64,' + Buffer.from(three, 'utf8').toString('base64');

const styleBlock = `<style>\n${css}\n</style>`;
const scriptBlock =
  `<script type="importmap">{"imports":{"three":"${threeDataUrl}"}}</script>\n` +
  `<script type="module">\n${safeJs(js)}\n</script>`;

const title = `${data.meta.title} — ${data.meta.repo}`;
const json = safeJson(JSON.stringify(data, null, 1));

let out = tpl;

const styleAnchor = /<!--__CODEVIZ_STYLE__-->\s*<link rel="stylesheet" href="\.\/style\.css">/;
const scriptAnchor = /<!--__CODEVIZ_SCRIPT__-->\s*<script type="importmap">[\s\S]*?<\/script>\s*<script type="module" src="\.\/renderer\.js"><\/script>/;

if (!styleAnchor.test(out) || !scriptAnchor.test(out)) {
  console.error('template/index.html no longer matches the build anchors — did it get edited?');
  process.exit(1);
}

out = out.replace(styleAnchor, () => styleBlock);
out = out.replace(scriptAnchor, () => scriptBlock);
out = out.replace('__CODEVIZ_TITLE__', () => title.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));
out = out.replace('__CODEVIZ_DATA__', () => json);

writeFileSync(outPath, out, 'utf8');

const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`\n\x1b[32mbuilt\x1b[0m ${outPath}  (${kb} KB, self-contained)`);
console.log(`      ${data.nodes.length} nodes · ${data.edges.length} connections · ${data.groups.length} groups`);
