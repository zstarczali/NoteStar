// NoteStar – the notes tree (sidebar) and the note editor with Markdown preview.

import { invoke, h, icon, toast, modal, contextMenu, debounce, esc, relTime, basename, uiGet, uiSet } from './util.js';
import { t } from './i18n.js';

// ───────────────────────── names / paths ─────────────────────────

export const dirOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
export const extOf = (rel) => { const b = basename(rel); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
export const stemOf = (rel) => { const b = basename(rel); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };
export const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);

/** "Note (conflict 2026-11-15 1430).md" → the original "Note.md" path, else null. */
const CONFLICT_RE = / \((?:ütközés|conflict) \d{4}-\d{2}-\d{2} \d{4}\)(?: \d+)?(?=\.[^.]*$|$)/;
export const conflictOriginal = (rel) => (CONFLICT_RE.test(basename(rel)) ? joinRel(dirOf(rel), basename(rel).replace(CONFLICT_RE, '')) : null);

// ───────────────────────── Markdown (notes subset) ─────────────────────────

function inline(s) {
  const codes = [];
  let r = esc(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  r = r
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, txt, url) => `<a data-href="${url}" title="${url}">${txt}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a data-href="${url}" title="${url}">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  return r.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[+i]}</code>`);
}

/** Markdown → HTML. Task boxes carry their source line (data-line) so they can be ticked. */
export function mdRender(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  let out = '';
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];
  const flushPara = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  const flushQuote = () => { if (quote.length) { out += `<blockquote>${mdRender(quote.join('\n'))}</blockquote>`; quote = []; } };
  const flushAll = () => { flushPara(); closeList(); flushQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    // fenced code
    if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
      flushAll();
      const fence = m[1];
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i]);
      out += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      continue;
    }
    if ((m = line.match(/^\s{0,3}>\s?(.*)$/))) { flushPara(); closeList(); quote.push(m[1]); continue; }
    flushQuote();
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { flushAll(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out += '<hr>'; continue; }
    // table: | a | b | followed by |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flushAll();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      out += '<table><thead><tr>' + cells(line).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      i++;
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) { i++; out += '<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'; }
      out += '</tbody></table>';
      continue;
    }
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out += `<${kind}>`; list = kind; }
      const ind = Math.min(6, Math.floor(m[1].replace(/\t/g, '    ').length / 2));
      const task = m[3].match(/^\[([ xX])\]\s*(.*)$/);
      if (task) {
        const done = task[1] !== ' ';
        out += `<li class="task${done ? ' done' : ''}" style="--ind:${ind}"><input type="checkbox" data-line="${i}"${done ? ' checked' : ''}>${inline(task[2])}</li>`;
      } else out += `<li style="--ind:${ind}">${inline(m[3])}</li>`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushAll();
  return out;
}

/** Plain-text counts for the status bar. */
export function textStats(s) {
  const words = (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  return { words, chars: s.length, lines: s ? s.split('\n').length : 0 };
}

// ───────────────────────── sidebar ─────────────────────────

/**
 * The notes tree with search. ctx: { settings, openNote(rel, opts), activeRel(),
 * newNote(dir), newFolder(dir), renameEntry(rel), deleteEntry(rel, dir), move(from, toDir),
 * reveal(rel), openExternal(rel), saveLater() }
 */
export function createSidebar(ctx) {
  const el = document.getElementById('sidebar');
  let entries = [];
  let query = '';
  let hits = null; // full-text results, null = show the tree
  let closed = new Set();
  try { closed = new Set(JSON.parse(uiGet('ns.closed') || '[]')); } catch { /* none */ }
  const saveClosed = () => uiSet('ns.closed', JSON.stringify([...closed]));

  const search = h('input.inp.side-search', { type: 'search', placeholder: t('Keresés a jegyzetekben… (Ctrl+Shift+F)'), spellcheck: 'false' });
  const body = h('div.side-tree');
  const sortBtn = h('button.icon-btn', { on: { click: () => {
    const s = ctx.settings();
    s.sort = s.sort === 'name' ? 'modified' : 'name';
    ctx.saveLater();
    draw();
  } } }, icon('sortIc'));
  const head = h('div.side-head',
    h('span.side-title', t('Jegyzetek')), h('span.grow'),
    h('button.icon-btn', { title: t('Új jegyzet (Ctrl+N)'), on: { click: () => ctx.newNote(currentDir()) } }, icon('newNote')),
    h('button.icon-btn', { title: t('Új mappa'), on: { click: () => ctx.newFolder(currentDir()) } }, icon('newFolder')),
    sortBtn,
    h('button.icon-btn', { title: t('Minden mappa összecsukása'), on: { click: () => { for (const e of entries) if (e.dir) closed.add(e.rel); saveClosed(); draw(); } } }, icon('collapse')),
    h('button.icon-btn', { title: t('Frissítés'), on: { click: () => refresh() } }, icon('refresh')));
  el.replaceChildren(head, h('div.side-filter', search), body);

  /** Folder of the open note: new notes go next to it. */
  const currentDir = () => { const r = ctx.activeRel(); return r ? dirOf(r) : ''; };

  const runSearch = debounce(async () => {
    const q = query;
    if (q.length < 2) { hits = null; draw(); return; }
    try {
      const res = await invoke('search_notes', { query: q });
      if (q === query) { hits = res; draw(); }
    } catch (e) { toast(String(e), 'err'); }
  }, 220);
  search.addEventListener('input', () => { query = search.value.trim(); if (!query) { hits = null; draw(); } else runSearch(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; query = ''; hits = null; draw(); }
    if (e.key === 'Enter' && hits?.length) ctx.openNote(hits[0].rel, { line: hits[0].line, find: query });
  });

  // ── drag & drop: move notes and folders ──
  let dragRel = null;
  const dropOn = (row, dir) => {
    row.addEventListener('dragover', (e) => {
      if (!dragRel || dragRel === dir || (dir + '/').startsWith(dragRel + '/') || dirOf(dragRel) === dir) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove('drop'); const from = dragRel; dragRel = null; if (from) ctx.move(from, dir); });
    row.addEventListener('dragend', () => { dragRel = null; row.classList.remove('drop'); });
  };
  dropOn(body, '');

  function sorted(list) {
    const byName = (a, b) => basename(a.rel).localeCompare(basename(b.rel), undefined, { numeric: true, sensitivity: 'base' });
    const dirs = list.filter((e) => e.dir).sort(byName);
    const files = list.filter((e) => !e.dir).sort(ctx.settings().sort === 'name' ? byName : (a, b) => b.mtime - a.mtime || byName(a, b));
    return [...dirs, ...files];
  }

  function draw() {
    sortBtn.title = ctx.settings().sort === 'name' ? t('Rendezés: név szerint (kattints: módosítás szerint)') : t('Rendezés: legutóbb módosított elöl (kattints: név szerint)');
    const active = ctx.activeRel();
    if (hits) {
      body.replaceChildren(hits.length ? hits.map((x) => h('div.hit' + (x.rel === active ? '.sel' : ''), {
        title: x.rel,
        on: { click: () => ctx.openNote(x.rel, { line: x.line, find: query }) },
      }, h('div.hit-name', icon('note'), h('span', stemOf(x.rel)), x.count ? h('span.hit-cnt', String(x.count)) : null),
      dirOf(x.rel) ? h('div.hit-dir', dirOf(x.rel)) : null,
      x.snippet ? h('div.hit-snip', { html: highlight(x.snippet, query) }) : null)) : h('div.empty-small', t('Nincs találat.')));
      return;
    }
    const kids = new Map();
    for (const e of entries) {
      const d = dirOf(e.rel);
      if (!kids.has(d)) kids.set(d, []);
      kids.get(d).push(e);
    }
    const q = query.toLowerCase();
    const rows = [];
    const visible = (e) => !q || e.rel.toLowerCase().includes(q);
    const countNotes = (dir) => (kids.get(dir) || []).reduce((n, e) => n + (e.dir ? countNotes(e.rel) : 1), 0);
    const walk = (dir, lvl) => {
      for (const e of sorted(kids.get(dir) || [])) {
        if (e.dir) {
          const open = !closed.has(e.rel) || !!q;
          const row = h('div.trow.tdir' + (open ? '.open' : ''), {
            style: { '--lvl': lvl }, title: e.rel, draggable: 'true',
            on: {
              click: () => { if (closed.has(e.rel)) closed.delete(e.rel); else closed.add(e.rel); saveClosed(); draw(); },
              dragstart: (ev) => { dragRel = e.rel; ev.dataTransfer.setData('text/plain', e.rel); },
              contextmenu: (ev) => contextMenu(ev, [
                { label: t('Új jegyzet itt'), icon: 'newNote', action: () => ctx.newNote(e.rel) },
                { label: t('Új mappa itt'), icon: 'newFolder', action: () => ctx.newFolder(e.rel) },
                '-',
                { label: t('Átnevezés…'), icon: 'rename', key: 'F2', action: () => ctx.renameEntry(e.rel, true) },
                { label: t('Megjelenítés a mappában'), icon: 'folderOpen', action: () => ctx.reveal(e.rel) },
                '-',
                { label: t('Törlés (lomtárba)'), icon: 'trash', danger: true, action: () => ctx.deleteEntry(e.rel, true) },
              ]),
            },
          }, icon('chev', 'chev'), icon(open ? 'folderOpen' : 'folder'), h('span.nm', basename(e.rel)), h('span.cnt', String(countNotes(e.rel) || '')));
          dropOn(row, e.rel);
          rows.push(row);
          if (open) walk(e.rel, lvl + 1);
        } else if (visible(e)) {
          const ext = extOf(e.rel);
          const conflict = !!conflictOriginal(e.rel);
          rows.push(h('div.trow.tnote' + (e.rel === active ? '.sel' : '') + (conflict ? '.conflict' : ''), {
            style: { '--lvl': lvl }, title: `${e.rel}\n${t('Módosítva: {0}', relTime(e.mtime / 1000))}`, draggable: 'true',
            dataset: { rel: e.rel },
            on: {
              click: () => ctx.openNote(e.rel),
              dragstart: (ev) => { dragRel = e.rel; ev.dataTransfer.setData('text/plain', e.rel); },
              contextmenu: (ev) => contextMenu(ev, [
                { label: t('Megnyitás'), icon: 'note', action: () => ctx.openNote(e.rel) },
                { label: t('Átnevezés…'), icon: 'rename', key: 'F2', action: () => ctx.renameEntry(e.rel, false) },
                { label: t('Megnyitás külső programmal'), icon: 'open', action: () => ctx.openExternal(e.rel) },
                { label: t('Megjelenítés a mappában'), icon: 'folderOpen', action: () => ctx.reveal(e.rel) },
                { label: t('Útvonal másolása'), icon: 'copy', action: () => invoke('note_path', { rel: e.rel }).then((p) => navigator.clipboard.writeText(p)).then(() => toast(t('Vágólapra másolva'), 'ok', 1500)) },
                '-',
                { label: t('Törlés (lomtárba)'), icon: 'trash', danger: true, key: 'Del', action: () => ctx.deleteEntry(e.rel, false) },
              ]),
            },
          }, h('span.tsp'), icon(conflict ? 'warnTri' : 'note'), h('span.nm', stemOf(e.rel)), ext && ext !== 'md' ? h('span.ext', ext) : null,
          h('span.tm', relTime(e.mtime / 1000))));
        }
      }
    };
    walk('', 0);
    if (!entries.length) rows.push(h('div.empty-small', t('Még nincs jegyzet. Hozz létre egyet (Ctrl+N).')));
    else if (!rows.length) rows.push(h('div.empty-small', t('Nincs találat.')));
    body.replaceChildren(...rows);
    body.querySelector('.trow.sel')?.scrollIntoView({ block: 'nearest' });
  }

  async function refresh() {
    try { entries = await invoke('list_notes'); }
    catch (e) { toast(String(e), 'err'); entries = []; }
    if (hits && query.length >= 2) runSearch();
    draw();
    return entries;
  }

  return {
    refresh,
    draw,
    entries: () => entries,
    focusSearch: () => { search.focus(); search.select(); },
    /** Opens the folders above `rel` so it can be seen. */
    reveal: (rel) => { let d = dirOf(rel); let ch = false; while (d) { if (closed.delete(d)) ch = true; d = dirOf(d); } if (ch) saveClosed(); draw(); },
  };
}

function highlight(snippet, q) {
  const s = esc(snippet);
  if (!q) return s;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return s.replace(re, (m) => `<mark>${m}</mark>`);
}

// ───────────────────────── editor ─────────────────────────

/**
 * One open note. ctx: { settings, changed(), saved(view), openNote(rel), aiMerge(view), aiNote(view),
 * aiOn(), deleteEntry(rel), confirm, keepBoth(view) }
 */
export class NoteView {
  constructor(ctx, rel) {
    this.ctx = ctx;
    this.rel = rel;
    this.text = '';
    this.savedText = '';
    this.mtime = 0;
    this.lossy = false;
    this.loaded = false;
    this.saving = false;
    this.error = '';
    this.mode = ctx.settings().view_mode || 'edit';
    this.root = null;
    this.saveSoon = debounce(() => this.save(), 700);
  }

  title() { return stemOf(this.rel); }
  tooltip() { return this.rel; }
  isDirty() { return this.text !== this.savedText; }

  async load() {
    try {
      const n = await invoke('read_note', { rel: this.rel });
      this.text = this.savedText = n.text;
      this.mtime = n.mtime;
      this.lossy = n.lossy;
      this.loaded = true;
      this.error = '';
    } catch (e) {
      this.error = String(e);
      this.loaded = false;
    }
    if (this.root) this.fill();
    return this.loaded;
  }

  /** Saves if there is something to save. Returns false when it failed. */
  async save({ force = false } = {}) {
    if (!this.loaded || this.lossy || (!this.isDirty() && !force)) return true;
    if (this.saving) { this.saveSoon(); return true; }
    this.saving = true;
    const text = this.text;
    this.ctx.changed();
    try {
      const r = await invoke('write_note', { rel: this.rel, text, expect: this.mtime, force });
      this.mtime = r.mtime;
      this.savedText = text;
      this.ctx.saved(this);
      return true;
    } catch (e) {
      if (String(e) === 'NOTE_CHANGED') return this.resolveChanged();
      toast(t('Mentés sikertelen: {0}', String(e)), 'err');
      return false;
    } finally {
      this.saving = false;
      this.ctx.changed();
    }
  }

  /** The file changed on disk (sync, other program) while there were unsaved edits here. */
  async resolveChanged() {
    const res = await modal({
      title: t('A jegyzet közben megváltozott'),
      body: h('div.desc', t('A(z) „{0}” fájlt közben egy másik program vagy a szinkron módosította, és itt is vannak nem mentett változások.', this.title())),
      buttons: [
        { label: t('Újratöltés (az itteni változások elvesznek)'), value: 'reload', danger: true },
        { label: t('Mindkettő megtartása'), value: 'both' },
        { label: t('Felülírás az itteni szöveggel'), value: 'force', primary: true },
      ],
    });
    if (res === 'reload') { await this.load(); this.ctx.changed(); return true; }
    if (res === 'both') return this.ctx.keepBoth(this);
    if (res === 'force') return this.save({ force: true });
    return false;
  }

  /** Called on window focus / after a sync: picks up changes made elsewhere. */
  async checkExternal() {
    if (!this.loaded || this.saving) return;
    let n;
    try { n = await invoke('read_note', { rel: this.rel }); } catch { return; }
    if (n.mtime === this.mtime) return;
    if (this.isDirty()) {
      if (n.text === this.text) { this.mtime = n.mtime; this.savedText = n.text; this.ctx.changed(); }
      return; // the next save asks what to do
    }
    const keep = this.ta ? [this.ta.selectionStart, this.ta.selectionEnd, this.ta.scrollTop] : null;
    this.text = this.savedText = n.text;
    this.mtime = n.mtime;
    this.lossy = n.lossy;
    if (this.root) {
      this.fill();
      if (keep) { this.ta.setSelectionRange(Math.min(keep[0], this.text.length), Math.min(keep[1], this.text.length)); this.ta.scrollTop = keep[2]; }
    }
    this.ctx.changed();
  }

  renamed(rel) { this.rel = rel; if (this.root) this.drawHead(); }

  setMode(m) {
    this.mode = m;
    if (this.root) this.applyMode();
    this.ctx.settings().view_mode = m;
    this.ctx.saveSettings();
    this.ctx.changed();
  }

  // ── DOM ──
  build() {
    const s = this.ctx.settings();
    this.ta = h('textarea.ed-text', { spellcheck: s.spellcheck ? 'true' : 'false', placeholder: t('Írj valamit… (Markdown: # cím, - lista, - [ ] teendő, **félkövér**)') });
    this.preview = h('div.md-view');
    this.head = h('div.ed-head');
    this.banner = h('div.ed-banner');
    this.findBar = null;
    this.body = h('div.ed-body', h('div.ed-pane.ed-src', this.ta), h('div.ed-pane.ed-prev', this.preview));
    this.root = h('div.ed', this.head, this.banner, this.body);

    this.ta.addEventListener('input', () => {
      this.text = this.ta.value;
      this.ctx.changed();
      this.saveSoon();
      if (this.mode !== 'edit') this.renderPreview();
    });
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('scroll', () => {
      if (this.mode !== 'split') return;
      const r = this.ta.scrollTop / Math.max(1, this.ta.scrollHeight - this.ta.clientHeight);
      const p = this.preview.parentElement;
      p.scrollTop = r * (p.scrollHeight - p.clientHeight);
    });
    this.preview.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-href]');
      if (a) { e.preventDefault(); invoke('open_url', { url: a.dataset.href }).catch((err) => toast(String(err), 'err')); return; }
      const cb = e.target.closest('input[type=checkbox][data-line]');
      if (cb) this.toggleTask(+cb.dataset.line);
    });
    this.preview.addEventListener('dblclick', () => { if (this.mode === 'preview') this.setMode('edit'); });
  }

  fill() {
    if (this.error) {
      this.body.replaceChildren(h('div.empty', icon('warnTri'), t('A jegyzet nem olvasható:'), h('div.desc', this.error)));
      return;
    }
    this.ta.value = this.text;
    this.ta.readOnly = this.lossy;
    this.applyStyle();
    this.drawHead();
    this.applyMode();
  }

  applyStyle() {
    const s = this.ctx.settings();
    this.ta.classList.toggle('mono', s.editor_font !== 'sans');
    this.ta.classList.toggle('nowrap', s.editor_wrap === false);
    this.ta.spellcheck = !!s.spellcheck;
    this.root.style.setProperty('--ed-size', (s.editor_font_size || 14) + 'px');
  }

  drawHead() {
    const parts = this.rel.split('/');
    const seg = h('span.seg.ed-mode', [['edit', t('Szerkesztés'), 'edit'], ['split', t('Osztott'), 'split'], ['preview', t('Előnézet'), 'eye']].map(([m, label, ic]) =>
      h('button' + (this.mode === m ? '.on' : ''), { type: 'button', title: label + (m === 'preview' ? ' (Ctrl+E)' : ''), on: { click: () => this.setMode(m) } }, icon(ic), label)));
    this.head.replaceChildren(
      h('div.ed-crumbs', parts.map((p, i) => [i ? h('span.sep', '/') : null, h('span' + (i === parts.length - 1 ? '.last' : ''), i === parts.length - 1 ? stemOf(p) : p)])),
      this.lossy ? h('span.ed-ro', { title: t('A fájl nem UTF-8 kódolású; a sérülés elkerülésére csak olvasható.') }, t('csak olvasható')) : null,
      h('span.grow'),
      seg);
    // a sync conflict copy: offer the ways out
    const orig = conflictOriginal(this.rel);
    this.banner.replaceChildren(orig ? h('div.ed-conflict', icon('warnTri'),
      h('span', t('Szinkron-ütközés másolata. Az eredeti: „{0}”. Fésüld össze, majd töröld ezt a másolatot.', stemOf(orig))),
      h('span.grow'),
      h('button.btn.sm', { on: { click: () => this.ctx.openNote(orig) } }, icon('note'), t('Eredeti megnyitása')),
      this.ctx.aiOn() ? h('button.btn.sm.ai', { on: { click: () => this.ctx.aiMerge(this, orig) } }, icon('sparkle'), t('AI összefésülés')) : null,
      h('button.btn.sm', { on: { click: () => this.ctx.deleteEntry(this.rel, false) } }, icon('trash'), t('Másolat törlése'))) : null);
  }

  applyMode() {
    this.body.className = 'ed-body mode-' + this.mode;
    if (this.mode !== 'edit') this.renderPreview();
    this.drawHead();
  }

  renderPreview() {
    this.preview.innerHTML = mdRender(this.text) || `<p class="dim">${esc(t('(üres jegyzet)'))}</p>`;
  }

  mount(el) {
    if (!this.root) { this.build(); if (this.loaded || this.error) this.fill(); }
    el.replaceChildren(this.root);
    if (this.mode !== 'preview' && !this.lossy) setTimeout(() => this.ta.focus(), 0);
  }

  status() {
    const st = textStats(this.text);
    return [
      h('span', t('{0} szó · {1} karakter · {2} sor', st.words, st.chars, st.lines)),
      h('span.save-st' + (this.isDirty() ? '.dirty' : ''), this.lossy ? t('Csak olvasható') : this.saving ? t('Mentés…') : this.isDirty() ? t('Nem mentett') : t('Mentve')),
    ];
  }

  // ── editing helpers ──
  insert(text) {
    this.ta.focus();
    // execCommand keeps the native undo history (Ctrl+Z)
    const ok = text === ''
      ? this.ta.selectionStart === this.ta.selectionEnd || document.execCommand('delete')
      : document.execCommand('insertText', false, text);
    if (!ok) this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
    this.ta.dispatchEvent(new Event('input'));
  }

  wrap(mark) {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    const sel = value.slice(a, b);
    this.insert(mark + sel + mark);
    if (!sel) this.ta.setSelectionRange(a + mark.length, a + mark.length);
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const { selectionStart: a, value } = this.ta;
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const line = value.slice(lineStart, value.indexOf('\n', a) < 0 ? value.length : value.indexOf('\n', a));
      // in a list item: indent / outdent the item, elsewhere a tab
      if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
        this.ta.setSelectionRange(lineStart, lineStart);
        if (e.shiftKey) { const n = line.startsWith('\t') ? 1 : Math.min(2, line.length - line.trimStart().length); this.ta.setSelectionRange(lineStart, lineStart + n); if (n) this.insert(''); this.ta.setSelectionRange(a - n, a - n); }
        else { this.insert('  '); this.ta.setSelectionRange(a + 2, a + 2); }
      } else if (!e.shiftKey) this.insert('\t');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      const { selectionStart: a, selectionEnd: b, value } = this.ta;
      if (a !== b) return;
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const line = value.slice(lineStart, a);
      const m = line.match(/^(\s*)([-*+]|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/);
      if (!m) return;
      e.preventDefault();
      if (line.length === m[0].length) { // empty item: end the list
        this.ta.setSelectionRange(lineStart, a);
        this.insert('');
        return;
      }
      const marker = m[3] ? `${+m[3] + 1}${m[4]}` : m[2];
      this.insert(`\n${m[1]}${marker} ${m[5] ? '[ ] ' : ''}`);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); this.wrap('**'); }
      else if (k === 'i') { e.preventDefault(); this.wrap('*'); }
    }
  }

  toggleTask(lineNo) {
    const lines = this.text.split('\n');
    const l = lines[lineNo];
    if (l == null) return;
    lines[lineNo] = l.replace(/\[([ xX])\]/, (m, c) => (c === ' ' ? '[x]' : '[ ]'));
    this.setText(lines.join('\n'));
  }

  /** Replaces the whole text (AI result, task toggle) keeping undo where possible. */
  setText(text) {
    if (!this.ta) { this.text = text; this.saveSoon(); return; }
    const top = this.ta.scrollTop;
    this.ta.focus();
    this.ta.select();
    this.insert(text);
    this.ta.scrollTop = top;
  }

  gotoLine(line, find) {
    if (!this.ta || !line) return;
    const lines = this.text.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    let end = pos;
    if (find) {
      const at = lines[line - 1]?.toLowerCase().indexOf(find.toLowerCase()) ?? -1;
      if (at >= 0) { pos += at; end = pos + find.length; }
    }
    if (this.mode === 'preview') this.setMode('split');
    this.ta.focus();
    this.ta.setSelectionRange(pos, end);
    // scroll the caret to the middle: measure with the line height
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 20;
    this.ta.scrollTop = Math.max(0, (line - 1) * lh - this.ta.clientHeight / 3);
  }

  // ── find in note ──
  openFind() {
    if (this.findBar) { this.findBar.querySelector('input').select(); return; }
    const inp = h('input.inp', { placeholder: t('Keresés a jegyzetben…'), spellcheck: 'false' });
    const cnt = h('span.cnt');
    const go = (dir) => {
      const q = inp.value.toLowerCase();
      if (!q) return;
      const v = this.ta.value.toLowerCase();
      let from = dir > 0 ? this.ta.selectionEnd : this.ta.selectionStart - 1;
      let at = dir > 0 ? v.indexOf(q, from) : v.lastIndexOf(q, Math.max(0, from));
      if (at < 0) at = dir > 0 ? v.indexOf(q) : v.lastIndexOf(q);
      const total = v.split(q).length - 1;
      cnt.textContent = total ? `${v.slice(0, Math.max(0, at)).split(q).length}/${total}` : t('nincs');
      this.findBar.classList.toggle('none', !total);
      if (at < 0) return;
      if (this.mode === 'preview') this.setMode('split');
      this.ta.focus();
      this.ta.setSelectionRange(at, at + q.length);
      const line = this.ta.value.slice(0, at).split('\n').length;
      const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 20;
      this.ta.scrollTop = Math.max(0, (line - 1) * lh - this.ta.clientHeight / 3);
      inp.focus();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeFind(); }
    });
    inp.addEventListener('input', () => { this.ta.setSelectionRange(this.ta.selectionStart, this.ta.selectionStart); go(1); });
    this.findBar = h('div.ed-find', icon('search'), inp, cnt,
      h('button.icon-btn', { title: t('Előző (Shift+Enter)'), on: { click: () => go(-1) } }, icon('up')),
      h('button.icon-btn', { title: t('Következő (Enter)'), on: { click: () => go(1) } }, icon('down')),
      h('button.icon-btn', { title: t('Bezárás'), on: { click: () => this.closeFind() } }, icon('close')));
    this.root.append(this.findBar);
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (sel && !sel.includes('\n')) inp.value = sel;
    inp.focus();
    inp.select();
  }

  closeFind() { this.findBar?.remove(); this.findBar = null; this.ta?.focus(); }
}
