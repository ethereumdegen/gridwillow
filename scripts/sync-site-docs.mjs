// Regenerates everything under site/docs, plus site/llms.txt, site/llms-full.txt
// and site/sitemap.xml, from the canonical sources in this repo.
//
// Railway builds site/ in isolation — it has no view of PROTOCOL.md or skills/ —
// so anything the site serves has to physically live inside site/. These copies
// are generated and committed, like site/payments.blueprint.html. Edit the
// source, then run this.
//
//   npm run sync:site           # write
//   npm run check:site          # exit 1 if anything is stale
//
// The markdown renderer below is deliberately small: it handles the subset of
// GFM these four documents actually use. It is not a general converter and does
// not need to be — the inputs live in this repo and this script runs over them
// on every change.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE = join(ROOT, 'site');
const ORIGIN = 'https://gridwillow.com';
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------- the manifest

// `slug` is the URL. `source` is the file of record. `blurb` is what an agent
// reads in llms.txt to decide whether this page answers its question, so it is
// written for that reader rather than as a title.
const PAGES = [
  {
    slug: 'language',
    source: 'PROTOCOL.md',
    title: 'The .bp language',
    blurb: 'The complete language reference — the two rules, the whole syntax on '
         + 'one screen, the eight-shape table, the six connection kinds, every '
         + 'attribute by scope, prose blocks and inline markup, and what the '
         + 'checker treats as an error versus a warning. Read this one first.',
  },
  {
    slug: 'writing-a-blueprint',
    source: 'skills/gridwillow-blueprint/SKILL.md',
    title: 'Writing a blueprint',
    blurb: 'The procedure to follow against a real codebase: survey before '
         + 'writing anything, choose 15–40 subsystem blocks, trace only the '
         + 'connections you can name, then let `bp check` grade the result.',
  },
  {
    slug: 'prose',
    source: 'skills/gridwillow-blueprint/reference/voice.md',
    title: 'Writing the prose',
    blurb: 'How to write `is`, `why` and `carry` so the hover cards are worth '
         + 'opening. The default register of generated documentation is the '
         + 'wrong one here, and this page is about correcting it.',
  },
  {
    slug: 'keeping-it-true',
    source: 'skills/gridwillow-refresh/SKILL.md',
    title: 'Keeping a blueprint true',
    blurb: 'The procedure for re-checking an existing blueprint against the code '
         + 'it claims to describe — moved paths, deleted functions, new tables — '
         + 'and rewriting only what actually drifted.',
  },
];

// Served verbatim, with no HTML twin. The grammar and the schema are for
// machines, and the example is the single most useful thing to hand a model
// that is about to write one of these.
const RAW = [
  {
    path: 'docs/grammar.ebnf',
    source: 'spec/blueprint.ebnf',
    blurb: 'The formal grammar, in EBNF. The normative answer when the prose '
         + 'reference and your parser disagree.',
  },
  {
    path: 'docs/blueprint-ir.schema.json',
    source: 'spec/blueprint-ir.schema.json',
    blurb: 'JSON Schema for the compiled intermediate form the renderer '
         + 'consumes. You never write this by hand; `bp build` emits it.',
  },
  {
    path: 'examples/payments.bp',
    source: 'examples/payments.bp',
    blurb: 'A complete, checked blueprint of a payments platform — 16 blocks, '
         + '19 connections, groups, tabs and terms. The worked example, and the '
         + 'file rendered on the front page.',
  },
  {
    path: 'examples/self.bp',
    source: 'examples/self.bp',
    blurb: 'Gridwillow’s own architecture as a blueprint — the compiler, the '
         + 'renderer and the app, drawn in their own language.',
  },
];

// Copied byte-for-byte. The screenshot is the og:image — the card a link to
// gridwillow.com unfurls into, which is most people's first sight of a render.
const BINARY = [
  { path: 'preview.png', source: 'docs/preview.png' },
];

// ------------------------------------------------------------------- markdown

const esc = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Code spans come out before anything else touches the line, so that a
// `-write->` or a `<kind>` inside backticks survives intact.
function inline(text) {
  const spans = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`<code>${esc(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    `<a href="${href}">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

const slugify = (s) => s.toLowerCase()
  .replace(/`/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  const toc = [];
  const list = { open: null };
  let i = 0;

  const closeList = () => {
    if (list.open) { out.push(`</${list.open}>`); list.open = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      const lang = slugify(line.slice(3).trim());
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre${lang ? ` class="lang-${lang}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      const id = slugify(h[2]);
      if (level === 2) toc.push({ id, text: inline(h[2].trim()) });
      out.push(`<h${level} id="${id}">${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // a table is a header row followed by a delimiter row
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      closeList();
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push('<div class="scroll"><table>');
      out.push(`<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`);
      out.push(`<tbody>${body.map((r) =>
        `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`);
      out.push('</table></div>');
      continue;
    }

    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }

    // a list item, with its indented continuation lines folded in
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const want = /^\d/.test(li[2]) ? 'ol' : 'ul';
      if (list.open !== want) { closeList(); out.push(`<${want}>`); list.open = want; }
      const parts = [li[3]];
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        parts.push(lines[i++].trim());
      }
      out.push(`<li>${inline(parts.join(' '))}</li>`);
      continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !/^(#{1,6}\s|```|\||(---+|\*\*\*+)\s*$)/.test(lines[i])
           && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  closeList();
  return { html: out.join('\n'), toc };
}

// These documents cite repository paths, because in the repository that is what
// they are. On the site the same paths are served, so the HTML twin turns the
// citations into links. The markdown twin is left exactly as written — it is a
// mirror of the source file, and should stay one.
const CITED = {
  'spec/blueprint.ebnf': '/docs/grammar.ebnf',
  'spec/blueprint-ir.schema.json': '/docs/blueprint-ir.schema.json',
  'examples/payments.bp': '/examples/payments.bp',
  'examples/self.bp': '/examples/self.bp',
  'reference/language.md': '/docs/language',
  'reference/voice.md': '/docs/prose',
};

function linkCitations(html) {
  return html.replace(/<code>([^<]+)<\/code>/g, (whole, path) =>
    CITED[path] ? `<a href="${CITED[path]}">${whole}</a>` : whole);
}

// YAML frontmatter, as the two skills carry it. It stays in the .md twin — an
// agent that wants to install the skill needs it — and is lifted out of the HTML.
function splitFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: md.slice(m[0].length) };
}

// ------------------------------------------------------------------ the shell

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function page({ title, description, canonical, toc, body, markdown }) {
  // The contents belong after the title and the opening paragraphs — a reader
  // who has not yet been told what the page is has no use for a list of its
  // sections. Splice it in ahead of the first h2, swallowing the rule that
  // usually sits there so the page does not get two lines in a row.
  let article = body;
  if (toc.length) {
    const nav = `<nav class="toc" aria-label="On this page"><b>On this page</b><ol>${
      toc.map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`).join('')}</ol></nav>`;
    const at = body.indexOf('<h2 ');
    if (at > 0) {
      const head = body.slice(0, at).replace(/<hr>\n?$/, '');
      article = `${head}${nav}\n${body.slice(at)}`;
    } else {
      article = `${nav}\n${body}`;
    }
  }

  const alt = markdown
    ? `<link rel="alternate" type="text/markdown" href="${markdown}" title="${attr(title)} as markdown">`
    : '';

  const foot = markdown
    ? `<p>This page is also served as raw markdown at
         <a href="${markdown}"><code>${markdown.replace(ORIGIN, '')}</code></a>.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${attr(title)} — Gridwillow</title>
<meta name="description" content="${attr(description)}">
<link rel="canonical" href="${canonical}">
${alt}
<meta property="og:title" content="${attr(title)} — Gridwillow">
<meta property="og:description" content="${attr(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/docs.css">
</head>
<body>
<header class="bar">
  <a class="word" href="/">
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#111"/>
      <path d="M8 19l8-4.5 8 4.5-8 4.5z" fill="#cdc499"/>
      <path d="M8 19v-4l8-4.5 8 4.5v4" fill="none" stroke="#cdc499" stroke-width="1.6"/>
    </svg>
    Gridwillow
  </a>
  <nav class="barlinks">
    <a href="/docs/">Docs</a>
    <a href="/llms.txt">llms.txt</a>
    <a href="https://github.com/ethereumdegen/gridwillow">GitHub&nbsp;↗</a>
  </nav>
</header>

<main>
${toc.length ? '  <p class="crumb"><a href="/docs/">Documentation</a></p>' : ''}
  <article>
${article}
  </article>
  <footer class="pagefoot">
    ${foot}
    <p>Every document on this site is indexed in
       <a href="/llms.txt"><code>/llms.txt</code></a> and concatenated into one
       file at <a href="/llms-full.txt"><code>/llms-full.txt</code></a>.</p>
  </footer>
</main>
</body>
</html>
`;
}

// -------------------------------------------------------------- the docs index

function indexPage(pages, raw) {
  const rows = (items) => items.map((it) => `    <li>
      <a href="${it.href}">${attr(it.name)}</a>
      <p>${inline(it.blurb)}</p>
    </li>`).join('\n');

  const body = `<h1 id="documentation">Documentation</h1>
<p class="lede">Gridwillow is a text language for software architecture. You write
one <code>.bp</code> file describing a system — its services, stores, queues and
the data that moves between them — and the compiler draws it as an isometric
blueprint you can pan, hover and click through.</p>
<p>Every reference page here is served twice: as HTML at the link, and as raw
markdown at the same URL with <code>.md</code> on the end. If you are a coding
agent, the shortest path is <a href="/llms-full.txt"><code>/llms-full.txt</code></a>
— one fetch, everything below, enough to write a blueprint that compiles.</p>
<h2 id="reference">Reference</h2>
<ul class="index">
${rows(pages)}
</ul>
<h2 id="grammar-and-examples">Grammar and examples</h2>
<ul class="index">
${rows(raw)}
</ul>`;

  return page({
    title: 'Documentation',
    description: 'The Gridwillow language reference, the procedure for writing a '
      + 'blueprint from a codebase, the prose guide, the EBNF grammar and worked '
      + 'examples — each served as HTML and as raw markdown.',
    canonical: `${ORIGIN}/docs/`,
    toc: [],
    body,
  });
}

// ------------------------------------------------------------------------- run

const written = new Map();
const put = (rel, content) => written.set(rel, content);

const sources = new Map();
for (const p of [...PAGES, ...RAW]) {
  sources.set(p.source, await readFile(join(ROOT, p.source), 'utf8'));
}

const indexPages = [];
for (const p of PAGES) {
  const src = sources.get(p.source);
  const { meta, body } = splitFrontmatter(src);
  const { html, toc } = renderMarkdown(body);

  put(`docs/${p.slug}.md`, src);
  put(`docs/${p.slug}.html`, page({
    title: p.title,
    description: meta.description || p.blurb,
    canonical: `${ORIGIN}/docs/${p.slug}`,
    markdown: `${ORIGIN}/docs/${p.slug}.md`,
    toc,
    body: linkCitations(html),
  }));

  indexPages.push({ href: `/docs/${p.slug}`, name: p.title, blurb: p.blurb });
}

const indexRaw = RAW.map((r) => {
  put(r.path, sources.get(r.source));
  return { href: `/${r.path}`, name: `/${r.path}`, blurb: r.blurb };
});

put('docs/index.html', indexPage(indexPages, indexRaw));

// -------------------------------------------------------------------- llms.txt

const llms = `# Gridwillow

> A text language for software architecture. You write one \`.bp\` file naming a
> system's services, stores, queues and the data that moves between them; the
> Rust compiler renders it as an interactive isometric blueprint — one
> self-contained HTML file, with a hover card on every block and an inspector
> behind each one. Think Mermaid, for infrastructure, in three dimensions.

Gridwillow is built to be written by a coding agent pointed at a repository. Two
rules carry the design: every construct is one line beginning with a keyword,
and indentation is decorative — so a mis-indented generated file still parses
exactly the same. Every connection must name something concrete that crosses it
(a table, a route, a function, a type) or the checker rejects it. That rule is
what stops a generated architecture diagram from becoming boxes joined by vibes.

If you are going to read one file, read /llms-full.txt: it is every document
below, concatenated, and it is enough to write a blueprint that compiles.

## Start here

${PAGES.map((p) => `- [${p.title}](${ORIGIN}/docs/${p.slug}.md): ${p.blurb}`).join('\n')}

## Grammar and examples

${RAW.map((r) => `- [/${r.path}](${ORIGIN}/${r.path}): ${r.blurb}`).join('\n')}

## Using it

\`\`\`
cargo install --path crates/gridwillow-cli   # the \`bp\` binary, from a clone

bp check  infra.bp                # every problem at once, with line and column
bp build  infra.bp -o infra.json  # the compiled IR
bp fmt    infra.bp --write        # canonical formatting, in place
bp export infra.bp -o infra.html  # one self-contained HTML file
\`\`\`

\`--force\` builds or exports anyway when there are errors. The desktop app
(\`cd app && cargo tauri dev\`) redraws on every save.

The compiler is the grader. \`bp check\` splits its findings in two: errors block
a build (a connection to a block that does not exist, a dangling \`[[…|id]]\`, a
duplicate id, a value out of range), and warnings never do but each names a way
the drawing is worse to read (fewer than 15 or more than 40 blocks, a block
nothing connects to, a vague \`carry\` like "data", a one-sentence \`why\`).
Write, run \`bp check\`, fix what it reports, repeat.

## Optional

- [Source, issues and releases](https://github.com/ethereumdegen/gridwillow): the repository. MIT licensed; the compiler is Rust, the renderer is three.js, and there are no runtime dependencies.
- [Agent skills](https://github.com/ethereumdegen/gridwillow/tree/main/skills): \`SKILL.md\` files in the format Claude Code and OMP both discover. \`./skills/install.sh claude\` symlinks them into \`~/.claude/skills/\`; the same two documents are served here as /docs/writing-a-blueprint.md and /docs/keeping-it-true.md.
- [A rendered blueprint](${ORIGIN}/payments.blueprint.html): the compiled output of examples/payments.bp. About a megabyte of generated three.js scene — worth opening in a browser, not worth fetching as text.
`;
put('llms.txt', llms);

// --------------------------------------------------------------- llms-full.txt

const rule = '='.repeat(78);
const full = [
  llms.trimEnd(),
  '',
  rule,
  '',
  `# About this file

Everything linked above, concatenated, in reading order: the language reference,
the procedure for writing a blueprint from a codebase, the prose guide, the
procedure for keeping one true, the formal grammar, and a complete worked
example. Sections are separated by a line of "=".

Two of these documents ship as agent skills in the repository, so they cite
sibling files by relative path — \`reference/language.md\` is the language
reference and \`reference/voice.md\` is the prose guide. Both are already in
this file; there is nothing further to fetch.

${rule}
`,
  ...PAGES.map((p) => {
    const { body } = splitFrontmatter(sources.get(p.source));
    // Drop the document's own H1 so the concatenation has one heading per
    // section rather than a title immediately followed by a synonym of itself.
    const text = body.trim().replace(/^#\s+.*\n+/, '');
    return `# ${p.title}\n\n(source: ${ORIGIN}/docs/${p.slug}.md)\n\n${text}\n\n${rule}\n`;
  }),
  `# The formal grammar (EBNF)\n\n(source: ${ORIGIN}/docs/grammar.ebnf)\n\n`
    + `${sources.get('spec/blueprint.ebnf').trim()}\n\n${rule}\n`,
  '# A complete worked example\n\n'
    + `(source: ${ORIGIN}/examples/payments.bp — the file rendered on the front page)\n\n`
    + `${sources.get('examples/payments.bp').trim()}\n`,
].join('\n');
put('llms-full.txt', full);

// -------------------------------------------------------------------- sitemap

const urls = [
  { loc: `${ORIGIN}/`, priority: '1.0' },
  { loc: `${ORIGIN}/docs/`, priority: '0.9' },
  ...PAGES.map((p) => ({ loc: `${ORIGIN}/docs/${p.slug}`, priority: '0.8' })),
  { loc: `${ORIGIN}/llms.txt`, priority: '0.7' },
  { loc: `${ORIGIN}/llms-full.txt`, priority: '0.7' },
  ...PAGES.map((p) => ({ loc: `${ORIGIN}/docs/${p.slug}.md`, priority: '0.5' })),
  ...RAW.map((r) => ({ loc: `${ORIGIN}/${r.path}`, priority: '0.5' })),
];
put('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`);

// ----------------------------------------------------------------- write/check

let binaryStale = 0;

// Binaries are compared and copied as bytes; they never go through the
// text pipeline above.
for (const b of BINARY) {
  const from = join(ROOT, b.source);
  const to = join(SITE, b.path);
  const src = await readFile(from);
  let current = null;
  try { current = await readFile(to); } catch { /* missing counts as stale */ }
  if (current && current.equals(src)) continue;
  if (CHECK) {
    console.error(`stale: site/${b.path}`);
    binaryStale++;
  } else {
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, src);
    console.log(`wrote  site/${b.path}`);
  }
}

let stale = binaryStale;
for (const [rel, content] of written) {
  const file = join(SITE, rel);
  let current = null;
  try { current = await readFile(file, 'utf8'); } catch { /* missing counts as stale */ }
  if (current === content) continue;
  stale++;
  if (CHECK) {
    console.error(`stale: site/${rel}`);
  } else {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    console.log(`wrote  site/${rel}`);
  }
}

if (CHECK) {
  if (stale) {
    console.error(`\n${stale} file(s) out of date. Run: npm run sync:site`);
    process.exit(1);
  }
  console.log('site docs are up to date');
} else if (!stale) {
  console.log('site docs already up to date');
}
