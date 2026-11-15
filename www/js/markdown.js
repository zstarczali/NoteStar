// NoteStar – Markdown → safe HTML for the preview.
// Full CommonMark + GitHub Flavored Markdown (tables, task lists, strikethrough,
// autolinks, nested lists, HTML blocks …) by `marked`, plus ==highlight== and
// heading anchors. The result always goes through DOMPurify: notes can come
// from anywhere (sync), so no script, handler or iframe may survive.

import { Marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';

let slugs = new Map();

/** "Első lépések!" → "elso-lepesek", unique within one render. */
export function slugify(text) {
  const base = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  const n = slugs.get(base) || 0;
  slugs.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

const md = new Marked({ gfm: true, breaks: true });
md.use({
  hooks: { preprocess(src) { slugs = new Map(); return src; } },
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="h-${slugify(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
  extensions: [{
    // ==highlight==
    name: 'mark',
    level: 'inline',
    start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src);
      if (m) return { type: 'mark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      return undefined;
    },
    renderer(tok) { return `<mark>${this.parser.parseInline(tok.tokens)}</mark>`; },
  }],
});

const PURIFY = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
};

export function mdRender(src) {
  const html = md.parse(String(src ?? ''), { async: false });
  return DOMPurify.sanitize(html, PURIFY);
}

/**
 * Source line of every task checkbox, in document order (fenced code skipped),
 * so a click in the preview can tick the right line.
 */
export function taskLines(src) {
  const out = [];
  let fence = null;
  String(src).replace(/\r/g, '').split('\n').forEach((l, i) => {
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (!fence && /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?:\s|$)/.test(l)) out.push(i);
  });
  return out;
}

/** `href` of a link / image in note `noteRel` → path in the notes folder, or null (web, outside). */
export function resolveRel(noteRel, href) {
  let p = String(href || '').trim();
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//') || p.startsWith('#')) return null;
  p = p.replace(/^<|>$/g, '').replace(/[?#].*$/, '');
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  const parts = p.startsWith('/') ? [] : noteRel.split('/').slice(0, -1);
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/') || null;
}

/** Path of `rel` as written in note `noteRel` (relative, Markdown-safe). */
export function relLink(noteRel, rel) {
  const from = noteRel.split('/').slice(0, -1);
  const to = rel.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const path = [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
  return path.replace(/%/g, '%25').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}
