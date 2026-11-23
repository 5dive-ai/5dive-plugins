// SOURCE of lib/extract.bundle.cjs — DIVE-4515.
//
// WHY A BUNDLE AND NOT `npm ci` AT INSTALL TIME. `plugin add` writes into the
// root-owned store (/var/lib/5dive/plugins). An install step there means the
// network decides whether a box gets a working verb, and it means the bytes that
// run are whatever npm resolved that minute. Vendored, the extractor is a
// reviewed diff: a version bump shows up in a PR, and `plugin add` copies files.
//
// THE DOM. Defuddle's node entry takes any Document implementation and ships its
// own linkedom compat (dist/utils/linkedom-compat.js) — linkedom is defuddle's
// OWN optional dependency for this path, jsdom is not. It is also the smaller
// pin (linkedom 2.7M installed vs jsdom ~9M with its 20+ transitive deps, and
// jsdom pulls a JS engine surface we have no use for on a DOM that is already
// post-script). So: linkedom, at the version defuddle asks for.
//
// Rebuild with ./build.sh. The pins live in lib/pins.json, are inlined into the
// bundle at build time, and are printed into page.meta.json, so an artifact
// always names the code that made it.
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import fs from 'node:fs';

// The pins are INLINED at build time (esbuild --define), not read from a sibling
// file at runtime. A version string that can drift from the bytes it claims to
// describe is worse than none: page.meta.json's whole job is to name the code
// that produced page.md.
const PINS = __PINS__;

function arg(name) {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : '';
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

// ABSOLUTE URLS ONLY. A relative href in links[] is worthless to the caller: it
// has the page's markdown, not the page's base, and resolving it later means
// re-deriving a base we already knew here. An unresolvable href is DROPPED
// rather than emitted raw — a caller that fetches `/login` against its own cwd
// is the failure this avoids.
function abs(href, base) {
  if (!href) return '';
  try { return new URL(href, base).toString(); } catch { return ''; }
}

function textOf(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}


// KEY/VALUE TABLES SURVIVE THE READ (DIVE-6582). Defuddle is a readability
// extractor: it keeps the article and drops what looks like chrome, and a
// sidebar table of label/value rows — Wikipedia's `table.infobox`, a product
// spec box, a profile card — looks like chrome to it. Those tables are where a
// page states its facts ("Initial release 8 July 1996"), and the bench lost
// R1 3 of 3 because the date was only in the infobox. So they are read from the
// page BEFORE Defuddle runs and put back at the top of page.md as
// "label: value" lines. Not a Wikipedia rule: any table whose rows are mostly
// one label cell and one value cell counts, which is how OpenClaw's innerText
// read happened to keep them (it keeps every table; we keep the factual ones
// and leave data grids to Defuddle, which already renders those).
const FACT_TABLES_MAX = 6;
const FACT_ROWS_MAX = 60;
const FACT_VALUE_MAX = 300;

function cellText(cell) {
  const c = cell.cloneNode(true);
  // Footnote markers ([12]), hidden microdata and styles are not the value.
  for (const n of c.querySelectorAll('sup.reference, .reference, style, script, .noprint, [style*="display:none"], [hidden]')) n.remove();
  // A line break or a list item inside a cell separates values; keep that as "; ".
  for (const n of c.querySelectorAll('br')) n.replaceWith(c.ownerDocument.createTextNode('; '));
  for (const n of c.querySelectorAll('li')) n.appendChild(c.ownerDocument.createTextNode('; '));
  return (c.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ')
    .replace(/(\s*;\s*)+/g, '; ').replace(/^[;\s]+|[;\s]+$/g, '').trim();
}

// The rows that belong to THIS table, not to a table nested in one of its cells.
function ownRows(table) {
  return [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
}

function factTables(document) {
  const out = [];
  for (const table of document.querySelectorAll('table')) {
    if (out.length >= FACT_TABLES_MAX) break;
    if (table.parentElement && table.parentElement.closest('table')) continue; // nested: its parent speaks for it
    // A navigation box (a site's link grid, which Wikipedia also builds out of
    // th+td rows) is the page's menu, not its facts.
    if (table.closest('nav, [role="navigation"]')) continue;
    const rows = ownRows(table);
    if (rows.length < 2) continue;
    const facts = [];
    let pairs = 0, other = 0;
    for (const tr of rows) {
      const cells = [...tr.children].filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
      if (cells.length === 2 && (cells[0].tagName === 'TH' || cells[1].tagName === 'TD')) {
        const label = cellText(cells[0]).replace(/:$/, '');
        const value = cellText(cells[1]);
        if (label && value && label.length <= 80) {
          pairs++;
          if (facts.length < FACT_ROWS_MAX) {
            facts.push({ label, value: value.length > FACT_VALUE_MAX ? value.slice(0, FACT_VALUE_MAX) + '…' : value });
          }
          continue;
        }
      }
      if (cells.length === 1) continue; // a heading or image row inside the box
      other++;
    }
    // A label/value table, not a data grid: at least two pairs, and pairs are
    // the rows it is made of. A th+td first column alone is not enough — a
    // grid with a row header is three or more cells wide and lands in `other`.
    const named = /\binfobox\b/.test(table.getAttribute('class') || '');
    if (pairs >= 2 && (named || pairs >= 2 * other)) {
      const cap = table.querySelector('caption');
      const title = (cap && cellText(cap)) || '';
      out.push({ title, facts });
    }
  }
  return out;
}

// AN APP'S MAIN LIST SURVIVES THE READ (DIVE-9058, box report 1348). Defuddle's
// clutter list deletes every `form`, `fieldset`, `label`, `[role=listbox]` and
// `[role=option]` subtree whole: on an article those are a search box and a
// dropdown. A webmail inbox is built as one of them, a selectable list
// (listbox/option rows) or a list inside a form for its bulk-select checkboxes,
// so page.md came back with no senders and no subjects. A container holding a
// real share of the page's text is the page, not a widget: it is unwrapped here,
// before Defuddle runs, so Defuddle keeps what it holds. Small forms and
// dropdowns hold little text and are still deleted as before.
const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const BIG_LIST_CHARS = 500;
const BIG_LIST_SHARE = 0.3;
const BIG_LIST_FLOOR = 200;
const ROW_LABEL_CHARS = 30;

function textLen(node) {
  if (node.nodeType === 3) return node.data.replace(/\s+/g, ' ').trim().length;
  if (node.nodeType !== 1 || SKIP_TEXT.has(node.tagName)) return 0;
  let n = 0;
  for (const c of node.childNodes) n += textLen(c);
  return n;
}

function renameTo(el, tag) {
  const d = el.ownerDocument.createElement(tag);
  for (const a of [...el.attributes]) {
    if (a.name !== 'role' && a.name !== 'action' && a.name !== 'method') d.setAttribute(a.name, a.value);
  }
  while (el.firstChild) d.appendChild(el.firstChild);
  el.replaceWith(d);
  return d;
}

function keepBigLists(document) {
  const body = document.body;
  if (!body) return 0;
  const total = textLen(body);
  let kept = 0;
  for (const el of document.querySelectorAll('form, fieldset, [role="listbox"], [role="grid"], [role="treegrid"]')) {
    if (!body.contains(el)) continue;
    const len = textLen(el);
    if (!(len >= BIG_LIST_CHARS || (len >= BIG_LIST_FLOOR && total && len / total >= BIG_LIST_SHARE))) continue;
    kept++;
    const box = (el.tagName === 'FORM' || el.tagName === 'FIELDSET') ? renameTo(el, 'div') : el;
    box.removeAttribute('role');
    for (const o of box.querySelectorAll('[role="option"], [role="listbox"]')) o.removeAttribute('role');
    // A row wrapped in a <label> (click anywhere to select it) is a message, not
    // a field caption. A short label beside a checkbox stays a label.
    for (const l of box.querySelectorAll('label')) {
      if (textLen(l) > ROW_LABEL_CHARS) renameTo(l, 'span');
    }
  }
  return kept;
}

// THE BACKSTOP (DIVE-9058). Some other app page Defuddle empties, by a rule not
// handled above: when page.md is near-empty but the page plainly has text, the
// visible text goes in below it, one line per block, and the read says so
// (thin_extract). Read BEFORE Defuddle, which mutates this same document.
const THIN_MD_WORDS = 50;
const THIN_PAGE_WORDS = 300;
const VISIBLE_TEXT_MAX = 40000;
const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'MAIN', 'OL', 'OPTION', 'P',
  'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL']);

function visibleText(document) {
  const body = document.body;
  if (!body) return '';
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) { parts.push(node.data); return; }
    if (node.nodeType !== 1 || SKIP_TEXT.has(node.tagName)) return;
    if (node.matches('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [hidden], [aria-hidden="true"]')) return;
    const block = BLOCK.has(node.tagName) || node.getAttribute('role') === 'option' || node.getAttribute('role') === 'row';
    if (block) parts.push('\n');
    for (const c of node.childNodes) walk(c);
    if (block) parts.push('\n');
  };
  walk(body);
  return parts.join('').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

function wordCount(s) {
  return (s.match(/\S+/g) || []).length;
}

// ONE FUNCTION, TWO CALLERS (DIVE-6778). The CLI below reads stdin, as it always
// did. The served browser's session daemon requires this same bundle once and calls
// extract() on the HTML it already holds: a fresh `node` per page paid the 3 MB
// load and a cold JIT on every snapshot, act and read (1.4 s against 0.75 s warm,
// Wikipedia). Same code, same bytes in, same JSON out.
export async function extract(html, url) {
  const { document } = parseHTML(html);

  // canonical_url is NOT part of Defuddle's metadata, and it is the one field the
  // caller most needs to dedupe on, so it is read here from the page itself:
  // <link rel=canonical> first (the page's own claim), then og:url, then the URL
  // we asked for. Never invented.
  const canonEl = document.querySelector('link[rel="canonical"][href]');
  const ogUrl = document.querySelector('meta[property="og:url"][content]');
  const canonical_url =
    abs(canonEl && canonEl.getAttribute('href'), url) ||
    abs(ogUrl && ogUrl.getAttribute('content'), url) ||
    url;

  // Defuddle resolves the canonical itself and logs a parse warning when the
  // page used a relative href. We already resolved it above, so normalize the
  // live document too: the artifact stays quiet without changing the page's
  // claim or inventing a value.
  if (canonEl) canonEl.setAttribute('href', canonical_url);
  if (ogUrl) ogUrl.setAttribute('content', canonical_url);

  // Read BEFORE Defuddle: it works on this same document and removes the tables.
  const tables = factTables(document);
  const visible = visibleText(document);
  keepBigLists(document);

  // separateMarkdown ALONE, never `markdown: true`. With `markdown: true` Defuddle
  // REPLACES result.content with the markdown, and then links[]/images[] below
  // have no HTML left to read and come back empty — measured on 0.19.3. With
  // separateMarkdown the article stays HTML in .content and the markdown arrives
  // beside it in .contentMarkdown, which is the shape this verb needs: one parse,
  // both representations.
  const res = await Defuddle(document, url, { separateMarkdown: true });

  // links[] and images[] are read out of the EXTRACTED article, not the raw page.
  // That is the whole point of running Defuddle: the nav, the footer and the
  // cookie banner are what it removed, and re-harvesting their hrefs here would
  // hand them straight back. page.html is kept so a caller who wants the nav can
  // still get it.
  const { document: cdoc } = parseHTML(`<body>${res.content || ''}</body>`);
  const seen = new Set();
  const links = [];
  for (const a of cdoc.querySelectorAll('a[href]')) {
    const href = abs(a.getAttribute('href'), canonical_url || url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: textOf(a) });
  }
  const iseen = new Set();
  const images = [];
  for (const img of cdoc.querySelectorAll('img[src]')) {
    const src = abs(img.getAttribute('src'), canonical_url || url);
    if (!src || iseen.has(src)) continue;
    iseen.add(src);
    images.push({ src, alt: (img.getAttribute('alt') || '').trim() });
  }

  // A table Defuddle KEPT is already in the article; printing it twice would be
  // noise. Kept means every label of it is still in the article text.
  const body = (res.contentMarkdown || res.content || '').trim();
  const facts = tables.filter((t) => !t.facts.every((f) => body.includes(f.label)));
  const factLines = facts.map((t) =>
    (t.title ? `${t.title}\n` : '') + t.facts.map((f) => `- ${f.label}: ${f.value}`).join('\n'));
  let markdown = factLines.length
    ? `## Facts on the page (its label/value tables)\n\n${factLines.join('\n\n')}\n\n## Page text\n\n${body}`
    : body;
  let word_count = typeof res.wordCount === 'number' ? res.wordCount : 0;
  const thin_extract = wordCount(body) < THIN_MD_WORDS && wordCount(visible) > THIN_PAGE_WORDS;
  if (thin_extract) {
    const text = visible.length > VISIBLE_TEXT_MAX ? visible.slice(0, VISIBLE_TEXT_MAX) + '\n…' : visible;
    // An emptied article comes back as a bare `<body></body>`: that is no text to keep.
    const kept = markdown.replace(/<\/?body>/g, '').trim() ? markdown + '\n\n' : '';
    markdown = `${kept}## Visible text\n\n${text}`;
    word_count = wordCount(markdown);
  }
  const out = {
    url,
    canonical_url,
    title: res.title || '',
    description: res.description || '',
    author: res.author || '',
    published: res.published || '',
    site: res.site || '',
    word_count,
    links,
    images,
    facts,
    schema_org: res.schemaOrgData === undefined ? null : res.schemaOrgData,
    defuddle_version: PINS.defuddle,
    linkedom_version: PINS.linkedom,
    markdown,
  };
  // Only when it fired: an ordinary page's JSON, and so its page.meta.json, is unchanged.
  if (thin_extract) out.thin_extract = true;
  return out;
}

// The daemon sets this before it requires the bundle, so requiring it runs no CLI.
if (!globalThis.__FIVEDIVE_EXTRACT_LIB) {
  (async () => {
    const url = arg('url');
    if (!url) { process.stderr.write('extract: --url=<url> is required\n'); process.exit(64); }
    const html = readStdin();
    if (!html.trim()) { process.stderr.write('extract: empty HTML on stdin\n'); process.exit(65); }
    process.stdout.write(JSON.stringify(await extract(html, url)));
  })().catch((e) => {
    process.stderr.write('extract: ' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.exit(70);
  });
}
