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

(async () => {
  const url = arg('url');
  if (!url) { process.stderr.write('extract: --url=<url> is required\n'); process.exit(64); }
  const html = readStdin();
  if (!html.trim()) { process.stderr.write('extract: empty HTML on stdin\n'); process.exit(65); }

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

  const markdown = (res.contentMarkdown || res.content || '').trim();
  process.stdout.write(JSON.stringify({
    url,
    canonical_url,
    title: res.title || '',
    description: res.description || '',
    author: res.author || '',
    published: res.published || '',
    site: res.site || '',
    word_count: typeof res.wordCount === 'number' ? res.wordCount : 0,
    links,
    images,
    schema_org: res.schemaOrgData === undefined ? null : res.schemaOrgData,
    defuddle_version: PINS.defuddle,
    linkedom_version: PINS.linkedom,
    markdown,
  }));
})().catch((e) => {
  process.stderr.write('extract: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(70);
});
