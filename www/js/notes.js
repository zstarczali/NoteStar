// NoteStar – the notes tree (sidebar) and the note editor with Markdown preview.

import { invoke, h, icon, toast, modal, contextMenu, formDlg, debounce, esc, relTime, basename, uiGet, uiSet } from './util.js';
import { t } from './i18n.js';
import { mdRender, taskLines, resolveRel, relLink, setImageSize } from './markdown.js';

export { mdRender };

// ───────────────────────── names / paths ─────────────────────────

export const dirOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
export const extOf = (rel) => { const b = basename(rel); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
export const stemOf = (rel) => { const b = basename(rel); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };
export const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);

/** "Note (conflict 2026-11-15 1430).md" → the original "Note.md" path, else null. */
const CONFLICT_RE = / \((?:ütközés|conflict) \d{4}-\d{2}-\d{2} \d{4}\)(?: \d+)?(?=\.[^.]*$|$)/;
export const conflictOriginal = (rel) => (CONFLICT_RE.test(basename(rel)) ? joinRel(dirOf(rel), basename(rel).replace(CONFLICT_RE, '')) : null);

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
  const head = h('div.side-head');
  // texts depend on the UI language: redrawn on every refresh (the sidebar is built before the language is set)
  const drawHead = () => {
    search.placeholder = t('Keresés a jegyzetekben… (Ctrl+Shift+F)');
    head.replaceChildren(
      h('span.side-title', t('Jegyzetek')), h('span.grow'),
      h('button.icon-btn', { title: t('Új jegyzet (Ctrl+N)'), on: { click: () => ctx.newNote(currentDir()) } }, icon('newNote')),
      h('button.icon-btn', { title: t('Új mappa'), on: { click: () => ctx.newFolder(currentDir()) } }, icon('newFolder')),
      sortBtn,
      h('button.icon-btn', { title: t('Minden mappa összecsukása'), on: { click: () => { for (const e of entries) if (e.dir) closed.add(e.rel); saveClosed(); draw(); } } }, icon('collapse')),
      h('button.icon-btn', { title: t('Frissítés'), on: { click: () => refresh() } }, icon('refresh')));
  };
  drawHead();
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
    const countNotes = (dir) => (kids.get(dir) || []).reduce((n, e) => n + (e.dir ? countNotes(e.rel) : e.image ? 0 : 1), 0);
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
        } else if (visible(e) && e.image) {
          // a picture (attachment): preview on click, insert into the open note
          const name = basename(e.rel);
          rows.push(h('div.trow.tnote.timg', {
            style: { '--lvl': lvl }, title: `${e.rel}\n${fmtSize(e.size)} · ${t('Módosítva: {0}', relTime(e.mtime / 1000))}`, draggable: 'true',
            dataset: { rel: e.rel },
            on: {
              click: () => imagePreview(ctx, e),
              dragstart: (ev) => { dragRel = e.rel; ev.dataTransfer.setData('text/plain', e.rel); ev.dataTransfer.setData('application/x-notestar-image', e.rel); },
              contextmenu: (ev) => contextMenu(ev, [
                { label: t('Megtekintés'), icon: 'eye', action: () => imagePreview(ctx, e) },
                { label: t('Beszúrás a jegyzetbe'), icon: 'fmtImage', disabled: !ctx.activeRel(), action: () => ctx.linkImage(e.rel) },
                '-',
                { label: t('Átnevezés…'), icon: 'rename', key: 'F2', action: () => ctx.renameEntry(e.rel, false) },
                { label: t('Megnyitás külső programmal'), icon: 'open', action: () => ctx.openExternal(e.rel) },
                { label: t('Megjelenítés a mappában'), icon: 'folderOpen', action: () => ctx.reveal(e.rel) },
                { label: t('Útvonal másolása'), icon: 'copy', action: () => invoke('note_path', { rel: e.rel }).then((p) => navigator.clipboard.writeText(p)).then(() => toast(t('Vágólapra másolva'), 'ok', 1500)) },
                '-',
                { label: t('Törlés (lomtárba)'), icon: 'trash', danger: true, action: () => ctx.deleteEntry(e.rel, false) },
              ]),
            },
          }, h('span.tsp'), icon('fmtImage'), h('span.nm', name), h('span.tm', fmtSize(e.size))));
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
    drawHead();
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

// ───────────────────────── preview images / help ─────────────────────────

/** Local time for file names: 2026-11-15 19-47-12 */
const stamp = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };

const imgCache = new Map(); // rel → Promise<data URL>
function loadImage(rel) {
  let p = imgCache.get(rel);
  if (!p) {
    p = invoke('image_data', { rel });
    p.catch(() => imgCache.delete(rel));
    imgCache.set(rel, p);
    while (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value);
  }
  return p;
}
/** Images may have changed on disk (sync, other program). */
export const forgetImages = () => imgCache.clear();

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A picture of the notes folder in a dialog. */
async function imagePreview(ctx, e) {
  const img = h('img.img-prev-pic', { alt: basename(e.rel) });
  const info = h('div.desc', `${e.rel} · ${fmtSize(e.size)}`);
  img.addEventListener('load', () => { info.textContent = `${e.rel} · ${img.naturalWidth} × ${img.naturalHeight} px · ${fmtSize(e.size)}`; });
  loadImage(e.rel).then((url) => { img.src = url; }, (err) => { info.textContent = String(err); });
  const res = await modal({
    title: basename(e.rel), wide: true,
    body: h('div.img-prev', img, info),
    buttons: [
      { label: t('Megnyitás külső programmal'), value: 'ext' },
      ctx.activeRel() ? { label: t('Beszúrás a jegyzetbe'), value: 'insert' } : null,
      { label: t('Bezárás'), value: null, primary: true },
    ].filter(Boolean),
  });
  if (res === 'ext') ctx.openExternal(e.rel);
  if (res === 'insert') ctx.linkImage(e.rel);
}

/** Markdown cheat sheet: the source and what it looks like. */
function mdHelp() {
  const x = t('szöveg');
  const rows = [
    [t('Címsorok'), `# ${t('Cím')} 1\n## ${t('Cím')} 2\n### ${t('Cím')} 3`],
    [t('Kiemelések'), `**${t('félkövér')}**, *${t('dőlt')}*, ***${t('mindkettő')}***\n~~${t('áthúzott')}~~, ==${t('kiemelt')}==, \`${t('kód')}\``],
    [t('Felsorolás'), `- ${x}\n- ${x}\n  - ${t('beljebb')}`],
    [t('Számozott lista'), `1. ${x}\n2. ${x}`],
    [t('Teendők'), `- [ ] ${t('nyitott')}\n- [x] ${t('kész')}`],
    [t('Idézet'), `> ${x}\n>> ${t('beljebb')}`],
    [t('Hivatkozás'), `[NoteStar](https://example.com)\n<https://example.com>\n[${t('másik jegyzet')}](${t('Másik')}.md)\n[${t('ugrás címhez')}](#${slugHint(t('Cím'))}-1)`],
    [t('Kép'), `![${t('leírás')}](attachments/${t('kép')}.png)`],
    [t('Kép mérete'), `![${t('leírás')}|120](attachments/${t('kép')}.png)
![${t('leírás')}](attachments/${t('kép')}.png =60x)
<img src="attachments/${t('kép')}.png" width="30%">`],
    [t('Táblázat'), `| ${t('Bal')} | ${t('Közép')} | ${t('Jobb')} |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |`],
    [t('Kódblokk'), '```js\nconsole.log("hi");\n```'],
    [t('Elválasztó vonal'), '---'],
    [t('Sortörés, bekezdés'), `${t('Egy sor')}\n${t('új sor')}\n\n${t('Új bekezdés')}`],
    [t('Feloldás'), `\\*${t('nem dőlt')}\\*`],
    ['HTML', `<kbd>Ctrl</kbd> + <kbd>S</kbd>, H<sub>2</sub>O, x<sup>2</sup>`],
  ];
  const body = h('div.md-help',
    h('div.desc', t('A jegyzetek teljes Markdown-t ismernek (CommonMark + GitHub kiegészítések). Képet beilleszthetsz a vágólapról (Ctrl+V) vagy behúzhatsz a szerkesztőbe; a jegyzet melletti „attachments” mappába kerül, és szinkronizálódik.')),
    h('table', h('tbody', rows.map(([label, src]) => {
      const out = h('td.md-view');
      out.innerHTML = mdRender(src);
      // the examples point to a made-up file: show a built-in picture instead
      for (const img of out.querySelectorAll('img')) img.src = SAMPLE_IMG;
      return h('tr', h('th', label), h('td', h('pre', src)), out);
    }))));
  // examples only: links must not navigate the app window away
  body.addEventListener('click', (e) => { if (e.target.closest('a, input')) e.preventDefault(); });
  modal({ title: t('Markdown súgó'), body, wide: true, buttons: [{ label: t('Bezárás'), value: null, primary: true }] });
}
const SAMPLE_IMG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#4c1d95"/></linearGradient>'
  + '<linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#facc15"/><stop offset=".5" stop-color="#fb923c"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>'
  + '<rect width="240" height="120" rx="10" fill="url(#g)"/><path d="M0 120 L70 62 L110 92 L160 44 L240 104 V120 Z" fill="#6366f1" opacity=".55"/>'
  + '<path d="M190 18l5.9 12 13.1 1.9-9.5 9.3 2.2 13.1L190 48.1l-11.7 6.2 2.2-13.1-9.5-9.3 13.1-1.9z" fill="url(#s)"/></svg>');
const slugHint = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-');

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
    this.ta = h('textarea.ed-text', { spellcheck: s.spellcheck ? 'true' : 'false' });
    this.preview = h('div.md-view');
    this.head = h('div.ed-head');
    this.tools = h('div.ed-tools');
    this.banner = h('div.ed-banner');
    this.findBar = null;
    this.body = h('div.ed-body', h('div.ed-pane.ed-src', this.ta), h('div.ed-pane.ed-prev', this.preview));
    this.root = h('div.ed', this.head, this.tools, this.banner, this.body);

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
    const imgMenu = (e) => {
      const img = e.target.closest('img[data-raw]');
      if (!img || this.lossy) return false;
      this.imageMenu(e, img);
      return true;
    };
    this.preview.addEventListener('contextmenu', (e) => { imgMenu(e); });
    this.preview.addEventListener('click', (e) => {
      if (!e.target.closest('a') && imgMenu(e)) return;
      const a = e.target.closest('a[href]');
      if (a) { e.preventDefault(); this.followLink(a.getAttribute('href')); return; }
      const cb = e.target.closest('input[type=checkbox][data-line]');
      if (cb) this.toggleTask(+cb.dataset.line);
    });
    // images: pasted from the clipboard or dropped from Explorer are saved next to the note
    this.ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length || this.lossy) return;
      e.preventDefault();
      this.addImages(files, true);
    });
    this.ta.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.ta.addEventListener('drop', (e) => {
      // a picture dragged from the notes tree: link it where it was dropped
      const treeImg = e.dataTransfer?.getData('application/x-notestar-image');
      if (treeImg && !this.lossy) {
        e.preventDefault();
        this.ta.focus();
        this.linkImage(treeImg);
        return;
      }
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(f.name));
      if (!files.length || this.lossy) return;
      e.preventDefault();
      this.addImages(files, false);
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
    // language may have changed: refresh the texts too
    this.ta.placeholder = t('Írj valamit… (Markdown: # cím, - lista, - [ ] teendő, **félkövér**)');
    this.drawTools();
    if (!this.error) this.drawHead();
  }

  /** Formatting toolbar (Markdown is written into the text, the preview shows the result). */
  drawTools() {
    const b = (ic, title, fn, label) => h('button.icon-btn.fmt', {
      type: 'button', title,
      // keep the selection in the textarea
      on: { mousedown: (e) => e.preventDefault(), click: () => { if (!this.lossy) fn(); } },
    }, ic ? icon(ic) : h('span.fmt-txt', label));
    const sep = () => h('span.fmt-sep');
    this.tools.replaceChildren(
      b('fmtBold', t('Félkövér (Ctrl+B)'), () => this.fmtInline('**')),
      b('fmtItalic', t('Dőlt (Ctrl+I)'), () => this.fmtInline('*')),
      b('fmtStrike', t('Áthúzott (Ctrl+Shift+X)'), () => this.fmtInline('~~')),
      b('fmtMark', t('Kiemelés (Ctrl+Shift+H)'), () => this.fmtInline('==')),
      b('fmtCode', t('Kód (Ctrl+Shift+K)'), () => this.fmtCode()),
      sep(),
      b(null, t('Címsor 1 (Ctrl+1)'), () => this.fmtLines('h1'), 'H1'),
      b(null, t('Címsor 2 (Ctrl+2)'), () => this.fmtLines('h2'), 'H2'),
      b(null, t('Címsor 3 (Ctrl+3)'), () => this.fmtLines('h3'), 'H3'),
      sep(),
      b('fmtUl', t('Felsorolás (Ctrl+Shift+8)'), () => this.fmtLines('ul')),
      b('fmtOl', t('Számozott lista (Ctrl+Shift+7)'), () => this.fmtLines('ol')),
      b('checkSq', t('Teendő (Ctrl+Shift+9)'), () => this.fmtLines('task')),
      b('fmtQuote', t('Idézet'), () => this.fmtLines('quote')),
      sep(),
      b('link', t('Hivatkozás (Ctrl+K)'), () => this.fmtLink()),
      b('fmtImage', t('Kép beszúrása (beillesztés és behúzás is működik)'), () => this.pickImage()),
      b('fmtTable', t('Táblázat'), () => this.fmtTable()),
      b('fmtHr', t('Elválasztó vonal'), () => this.fmtHr()),
      h('span.grow'),
      b('info', t('Markdown súgó'), () => mdHelp()));
    this.tools.classList.toggle('disabled', !!this.lossy);
  }

  /** Bold / italic / ...: wraps the selection, or removes the marks when they are already there. */
  fmtInline(mark) {
    const ta = this.ta;
    const v = ta.value;
    let a = ta.selectionStart, b = ta.selectionEnd;
    // "**word **" would not render: keep the spaces outside
    while (a < b && /\s/.test(v[a])) a++;
    while (b > a && /\s/.test(v[b - 1])) b--;
    const L = mark.length;
    const sel = v.slice(a, b);
    // italic '*' must not eat half of a bold '**'
    const single = (i) => mark !== '*' || v.slice(i - 3, i) === '***' || (v[i - 2] !== '*');
    const singleR = (i) => mark !== '*' || v.slice(i, i + 3) === '***' || (v[i + 1] !== '*');
    if (v.slice(a - L, a) === mark && v.slice(b, b + L) === mark && single(a) && singleR(b)) {
      ta.setSelectionRange(a - L, b + L);
      this.insert(sel);
      ta.setSelectionRange(a - L, b - L);
    } else if (sel.length > 2 * L && sel.startsWith(mark) && sel.endsWith(mark)) {
      const inner = sel.slice(L, -L);
      ta.setSelectionRange(a, b);
      this.insert(inner);
      ta.setSelectionRange(a, a + inner.length);
    } else {
      ta.setSelectionRange(a, b);
      this.insert(mark + sel + mark);
      ta.setSelectionRange(a + L, a + L + sel.length);
    }
  }

  fmtCode() {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    if (!value.slice(a, b).includes('\n')) { this.fmtInline('`'); return; }
    // several lines: fenced block on whole lines
    const s = value.lastIndexOf('\n', a - 1) + 1;
    let e = value.indexOf('\n', b - (value[b - 1] === '\n' ? 1 : 0));
    if (e < 0) e = value.length;
    const body = value.slice(s, e);
    this.ta.setSelectionRange(s, e);
    this.insert('```\n' + body + '\n```');
    this.ta.setSelectionRange(s + 4, s + 4 + body.length);
  }

  fmtLink() {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    const sel = value.slice(a, b).trim();
    if (/^https?:\/\/\S+$/.test(sel)) {
      this.insert(`[](${sel})`);
      this.ta.setSelectionRange(a + 1, a + 1);
    } else {
      const url = 'https://';
      this.insert(`[${sel}](${url})`);
      const at = a + sel.length + 3;
      if (sel) this.ta.setSelectionRange(at, at + url.length);
      else this.ta.setSelectionRange(a + 1, a + 1);
    }
  }

  fmtHr() {
    const { selectionEnd: b, value } = this.ta;
    let e = value.indexOf('\n', b);
    if (e < 0) e = value.length;
    this.ta.setSelectionRange(e, e);
    const before = value.slice(0, e);
    this.insert((before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '') + '---\n\n');
  }

  /** Heading / list / task / quote on every line of the selection; again = off. */
  fmtLines(kind) {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    const s = value.lastIndexOf('\n', a - 1) + 1;
    let e = value.indexOf('\n', b > a && value[b - 1] === '\n' ? b - 1 : b);
    if (e < 0) e = value.length;
    const lines = value.slice(s, e).split('\n');
    const PRE = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;
    const kindOf = (l) => {
      const p = (l.match(PRE)[2] || '').trim();
      if (!p) return '';
      if (p.startsWith('#')) return 'h' + p.length;
      if (p.startsWith('>')) return 'quote';
      if (/\[[ xX]\]$/.test(p)) return 'task';
      return /^\d/.test(p) ? 'ol' : 'ul';
    };
    const filled = lines.filter((l) => l.trim());
    const off = filled.length > 0 && filled.every((l) => kindOf(l) === kind);
    let n = 0;
    const out = lines.map((l) => {
      if (!l.trim() && lines.length > 1) return l;
      const m = l.match(PRE);
      const ind = kind.startsWith('h') ? '' : m[1];
      const rest = l.slice(m[0].length);
      if (off) return m[1] + rest;
      const pre = { h1: '# ', h2: '## ', h3: '### ', quote: '> ', ul: '- ', task: '- [ ] ', ol: `${++n}. ` }[kind];
      return ind + pre + rest;
    });
    const text = out.join('\n');
    this.ta.setSelectionRange(s, e);
    this.insert(text);
    if (a === b && lines.length === 1) {
      // keep the caret on the same character
      const p = Math.max(s, a + (text.length - (e - s)));
      this.ta.setSelectionRange(p, p);
    } else this.ta.setSelectionRange(s, s + text.length);
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
    this.tools.classList.toggle('none', this.mode === 'preview');
    if (this.mode !== 'edit') this.renderPreview();
    this.drawHead();
  }

  renderPreview() {
    this.preview.innerHTML = mdRender(this.text) || `<p class="dim">${esc(t('(üres jegyzet)'))}</p>`;
    // task boxes: clickable, tied to their source line
    const lines = taskLines(this.text);
    this.preview.querySelectorAll('li input[type=checkbox]').forEach((cb, i) => {
      const li = cb.closest('li');
      li.classList.add('task');
      li.classList.toggle('done', cb.checked);
      if (li.parentElement) li.parentElement.classList.add('tasks');
      if (lines[i] == null) return;
      cb.disabled = this.lossy;
      cb.dataset.line = lines[i];
    });
    // pictures of the notes folder: the webview cannot read files, ask the backend
    const seen = new Map();
    for (const img of this.preview.querySelectorAll('img')) {
      img.loading = 'lazy';
      // remembered for the size menu: which image of the source this is
      const raw = img.getAttribute('src') || '';
      img.dataset.raw = raw;
      img.dataset.nth = seen.get(raw) || 0;
      seen.set(raw, +img.dataset.nth + 1);
      const rel = resolveRel(this.rel, raw);
      if (!rel) continue;
      img.removeAttribute('src');
      img.dataset.rel = rel;
      loadImage(rel).then((url) => { img.src = url; }, () => { img.classList.add('broken'); img.title = t('A kép nem található: {0}', rel); });
    }
  }

  /** Size menu of an image in the preview; the size is written into the note. */
  imageMenu(e, img) {
    const set = (size) => {
      const text = setImageSize(this.text, img.dataset.raw, +img.dataset.nth, size);
      if (text == null) { toast(t('A kép nem található a jegyzet szövegében.'), 'err'); return; }
      if (text !== this.text) this.setText(text);
      if (this.mode !== 'edit') this.renderPreview();
    };
    const cur = img.getAttribute('width') || '';
    const nat = img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight} px` : '';
    contextMenu(e, [
      { header: t('Kép mérete') + (nat ? ` (${t('eredeti')}: ${nat})` : '') },
      ...['25%', '50%', '75%', '100%'].map((p) => ({ label: p + (cur === p ? '  ✓' : ''), icon: 'fmtImage', action: () => set(p) })),
      ...['200', '400', '600'].map((p) => ({ label: `${p} px` + (cur === p ? '  ✓' : ''), icon: 'fmtImage', action: () => set(p) })),
      { label: t('Egyéni méret…'), icon: 'rename', action: async () => {
        const r = await formDlg(t('Kép mérete'), [{ name: 'w', label: t('Szélesség (px vagy %)'), value: cur, placeholder: '320 / 60%' }], 'OK',
          t('A magasság arányosan igazodik.'));
        if (!r) return;
        const w = String(r.w || '').trim().replace(/\s*px$/i, '');
        if (w && !/^\d{1,5}%?$/.test(w)) { toast(t('Érvénytelen méret: {0}', w), 'err'); return; }
        set(w);
      } },
      '-',
      { label: t('Eredeti méret'), icon: 'undo', disabled: !cur && !img.getAttribute('height'), action: () => set('') },
    ]);
  }

  followLink(href) {
    if (!href) return;
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      const el = this.preview.querySelector(`[id="h-${CSS.escape(id)}"]`) || this.preview.querySelector(`[id="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^(https?|mailto|ftp):/i.test(href)) { invoke('open_url', { url: href }).catch((err) => toast(String(err), 'err')); return; }
    const rel = resolveRel(this.rel, href);
    if (!rel) return;
    if (/\.(md|markdown|txt)$/i.test(rel)) this.ctx.openNote(rel);
    else this.ctx.openExternal(rel);
  }

  /** Saves image files next to the note and links them at the caret. */
  async addImages(files, pasted) {
    const links = [];
    for (const f of files) {
      try {
        const data = await new Promise((ok, bad) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result).split(',')[1] || '');
          r.onerror = () => bad(r.error);
          r.readAsDataURL(f);
        });
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        // a screenshot from the clipboard is always "image.png": give it a date instead
        const name = pasted || !f.name ? `${t('kép')} ${stamp()}.${ext}` : f.name;
        const rel = await invoke('save_image', { note: this.rel, name, data });
        links.push(`![${stemOf(rel)}](${relLink(this.rel, rel)})`);
      } catch (e) { toast(t('A kép mentése nem sikerült: {0}', String(e)), 'err'); }
    }
    if (links.length) this.insertBlock(links.join('\n'));
    this.ctx.refreshTree?.();
  }

  /** Links a picture of the notes folder at the caret. */
  linkImage(rel) {
    if (!this.ta || this.lossy) return;
    if (this.mode === 'preview') this.setMode('split');
    const base = basename(rel);
    const alt = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
    this.insertBlock(`![${alt}](${relLink(this.rel, rel)})`);
  }

  /** Picks image files in a dialog. */
  async pickImage() {
    const sel = await invoke('plugin:dialog|open', { options: {
      multiple: true, title: t('Kép beszúrása'),
      filters: [{ name: t('Képek'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'] }],
    } }).catch(() => null);
    const paths = !sel ? [] : Array.isArray(sel) ? sel : [sel];
    const links = [];
    for (const p of paths) {
      try {
        const rel = await invoke('import_image', { note: this.rel, path: p });
        links.push(`![${stemOf(rel)}](${relLink(this.rel, rel)})`);
      } catch (e) { toast(t('A kép mentése nem sikerült: {0}', String(e)), 'err'); }
    }
    if (links.length) this.insertBlock(links.join('\n'));
    this.ctx.refreshTree?.();
  }

  /** Inserts text on its own line(s) at the caret. */
  insertBlock(text) {
    const { selectionStart: a, value } = this.ta;
    const pre = a > 0 && value[a - 1] !== '\n' ? '\n' : '';
    const post = value[a] && value[a] !== '\n' ? '\n' : '';
    this.ta.setSelectionRange(a, a);
    this.insert(pre + text + post);
  }

  fmtTable() {
    const c1 = t('Oszlop 1'), c2 = t('Oszlop 2'), c3 = t('Oszlop 3');
    const table = `| ${c1} | ${c2} | ${c3} |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |`;
    const { selectionStart: a, value } = this.ta;
    const pre = a > 0 ? (value[a - 1] === '\n' ? (value[a - 2] === '\n' || a < 2 ? '' : '\n') : '\n\n') : '';
    this.ta.setSelectionRange(a, a);
    this.insert(pre + table + '\n');
    const at = a + pre.length + 2;
    this.ta.setSelectionRange(at, at + c1.length);
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
    if (mod && !e.altKey && !this.lossy) {
      // e.code: layout independent (Hungarian keyboard: Shift+7 is not '7')
      const act = e.shiftKey
        ? { KeyX: () => this.fmtInline('~~'), KeyH: () => this.fmtInline('=='), KeyK: () => this.fmtCode(),
          Digit8: () => this.fmtLines('ul'), Digit7: () => this.fmtLines('ol'), Digit9: () => this.fmtLines('task') }[e.code]
        : { KeyB: () => this.fmtInline('**'), KeyI: () => this.fmtInline('*'), KeyK: () => this.fmtLink(),
          Digit1: () => this.fmtLines('h1'), Digit2: () => this.fmtLines('h2'), Digit3: () => this.fmtLines('h3') }[e.code];
      if (act) { e.preventDefault(); e.stopPropagation(); act(); }
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
