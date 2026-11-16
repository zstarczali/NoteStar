// NoteStar – main UI shell: tabs, toolbar, sidebar, welcome page, settings,
// AI panel, about, self-update and the sync schedule. Notes: notes.js, sync: sync.js.

import {
  invoke, h, icon, toast, modal, confirmDlg, contextMenu, debounce, basename,
  initUiState, uiGet, uiSet, editMenu, splitter, relTime,
} from './util.js';
import { t, setLang, getLang } from './i18n.js';
import { aiUsageInit, aiUsageItem } from './aiusage.js';
import { NoteView, createSidebar, forgetImages, mdRender, dirOf, stemOf, extOf, joinRel, conflictOriginal, droppedFiles, isImageName, toggleStar, onStars, retargetStars, dropStars } from './notes.js';
import { createSyncer, syncSettingsPane } from './sync.js';

// ───────────────────────── state ─────────────────────────

const S = {
  settings: null,
  tabs: [],        // NoteView
  active: -1,
  busy: 0,
  busyLabel: '',
  syncText: '',
  syncInfo: [],
  donationVisible: false,
  update: null,
  notesDir: '',
};

const cur = () => S.tabs[S.active] || null;
const aiOn = () => !!S.settings?.ai_enabled;
const isDeepSeek = () => S.settings?.ai_provider === 'deepseek';
const isClaudeCli = () => S.settings?.ai_provider === 'claude-cli';
const aiKey = () => (isClaudeCli() ? 'cli' : (isDeepSeek() ? S.settings?.deepseek_api_key : S.settings?.anthropic_api_key) || '');
const aiProviderName = () => (isDeepSeek() ? 'DeepSeek' : isClaudeCli() ? 'Claude Code CLI' : 'Anthropic Claude');
const aiModel = () => (isDeepSeek() ? S.settings?.deepseek_model : S.settings?.ai_model) || '';

async function saveSettings() {
  try { await invoke('save_settings', { settings: S.settings }); } catch (e) { toast(String(e), 'err'); }
}
const saveLater = debounce(() => saveSettings(), 400);

// ───────────────────────── services for the views ─────────────────────────

const ctx = {
  settings: () => S.settings,
  saveSettings: () => saveLater(),
  saveLater: () => saveLater(),
  changed: () => { renderTabs(); renderToolbar(); renderStatusbar(); },
  saved: () => { sidebar.refresh(); syncAfterSave(); },
  openNote: (rel, opts) => openNote(rel, opts),
  refreshTree: () => sidebar.refresh(),
  linkImage: (rel) => { const v = cur(); if (v?.root) v.linkImage(rel); else toast(t('Előbb nyiss meg egy jegyzetet.'), 'err'); },
  activeRel: () => cur()?.rel || '',
  newNote: (dir) => newNote(dir),
  newFolder: (dir) => newFolder(dir),
  renameEntry: (rel, isDir) => renameEntry(rel, isDir),
  deleteEntry: (rel, isDir) => deleteEntry(rel, isDir),
  move: (from, toDir) => moveEntry(from, toDir),
  reveal: (rel) => invoke('note_path', { rel }).then((p) => invoke('reveal_in_explorer', { path: p })).catch((e) => toast(String(e), 'err')),
  openExternal: (rel) => invoke('note_path', { rel }).then((p) => invoke('open_file', { path: p })).catch((e) => toast(String(e), 'err')),
  aiOn: () => aiOn(),
  aiMerge: (view, orig) => aiMerge(view, orig),
  keepBoth: (view) => keepBoth(view),
  importFiles: (list, dir) => importFiles(list, dir),
  searchAll: (q) => searchAll(q),
};

/** Full-text search in every note, from the find bar / a selection. */
function searchAll(q) {
  sidebar.focusSearch((q || '').trim());
}

/**
 * Note files dropped from Explorer / Finder (dropped folders keep their structure),
 * copied into folder `dir` of the notes. `list`: Promise<[{ file, sub }]>.
 */
async function importFiles(list, dir = '') {
  let files;
  try { files = await list; } catch (e) { toast(String(e), 'err'); return; }
  files = files.filter((x) => x.file);
  if (!files.length) return;
  const done = [], skipped = [];
  for (const { file, sub } of files) {
    // pictures belong to a note: they are dropped into the editor instead
    if (isImageName(file.name)) { skipped.push(file.name); continue; }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      done.push(await invoke('import_note', { dir: joinRel(dir, sub), name: file.name, data: btoa(bin) }));
    } catch (e) { skipped.push(`${file.name}: ${e}`); }
  }
  await sidebar.refresh();
  if (done.length === 1) await openNote(done[0]);
  else if (done.length) { sidebar.reveal(done[0]); toast(t('{0} jegyzet importálva', done.length), 'ok'); }
  if (skipped.length) toast(t('Nem importálva ({0}):', skipped.length) + '\n' + skipped.slice(0, 6).join('\n') + (skipped.length > 6 ? '\n…' : ''), 'err', 7000);
  if (done.length) syncAfterSave();
}

const sidebar = createSidebar(ctx);

const syncer = createSyncer({
  settings: () => S.settings,
  flush: () => saveAll(),
  setBusy: (on, label) => setBusy(on, label),
  status: (text) => { S.syncText = text; renderStatusbar(); },
  after: async (reports) => {
    const entries = await sidebar.refresh();
    const exists = new Set(entries.filter((e) => !e.dir).map((e) => e.rel));
    // notes deleted by the sync: their tabs close (unless there are edits to keep)
    for (let i = S.tabs.length - 1; i >= 0; i--) if (!exists.has(S.tabs[i].rel) && !S.tabs[i].isDirty()) closeTab(i, true);
    forgetImages();
    for (const v of S.tabs) await v.checkExternal();
    // pictures may have arrived with the sync
    const av = cur();
    if (av?.root && av.mode !== 'edit') av.renderPreview();
    await loadSyncInfo();
    if (reports.some((r) => r.conflicts?.length)) renderAll();
  },
});

// ───────────────────────── theme / zoom / language ─────────────────────────

function applyLang() {
  setLang(S.settings.ui_language || 'auto');
  invoke('set_ui_language', { lang: getLang() }).catch(() => {});
}

function applyTheme() {
  let th = S.settings.theme;
  if (th === 'system') th = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = th;
  document.documentElement.style.setProperty('--font-size', (S.settings.font_size || 13) + 'px');
}

const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const zoomNow = () => S.settings?.zoom || 1;
function applyZoom() { invoke('set_zoom', { scale: zoomNow() }).catch(() => {}); }
function setZoom(z) {
  z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], Math.round(z * 100) / 100));
  if (z === zoomNow()) return;
  S.settings.zoom = z;
  applyZoom();
  saveLater();
  toast(t('Nagyítás: {0}%', Math.round(z * 100)), 'info', 1200);
  renderStatusbar();
}
function zoomStep(dir) {
  const z = zoomNow();
  if (dir === 0) return setZoom(1);
  const next = dir > 0 ? ZOOMS.find((x) => x > z + 0.001) : [...ZOOMS].reverse().find((x) => x < z - 0.001);
  if (next) setZoom(next);
}

// The toolbar button flips between plain dark and light; the rest is in Settings.
const THEME_UI = { dark: ['Sötét', 'moon'], light: ['Világos', 'sun'] };
const LIGHT_THEMES = ['light', 'modern'];
const nextBasicTheme = () => (LIGHT_THEMES.includes(document.documentElement.dataset.theme) ? 'dark' : 'light');
function toggleTheme() {
  S.settings.theme = nextBasicTheme();
  applyTheme();
  saveSettings();
  renderAll();
}

let busyTimer = 0;
function setBusy(on, label = '') {
  S.busy = Math.max(0, S.busy + (on ? 1 : -1));
  S.busyLabel = on ? label : S.busy ? S.busyLabel : '';
  clearTimeout(busyTimer);
  const bar = document.getElementById('busybar');
  if (S.busy) busyTimer = setTimeout(() => bar.classList.add('on'), 150);
  else bar.classList.remove('on');
  renderToolbar();
  renderStatusbar();
}

// ───────────────────────── session ─────────────────────────

function persistSession() {
  S.settings.open_notes = S.tabs.map((v) => v.rel);
  S.settings.active_note = S.active;
  saveLater();
}

// ───────────────────────── notes: open / create / rename / delete ─────────────────────────

async function openNote(rel, { line, find, background } = {}) {
  // a picture is not a note: show it with the system viewer
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(rel)) { ctx.openExternal(rel); return null; }
  let i = S.tabs.findIndex((v) => v.rel === rel);
  if (i < 0) {
    const v = new NoteView(ctx, rel);
    await v.load();
    if (v.error) { toast(v.error, 'err'); return null; }
    i = S.active >= 0 ? S.active + 1 : S.tabs.length;
    S.tabs.splice(i, 0, v);
  }
  if (!background) S.active = i;
  persistSession();
  sidebar.reveal(rel);
  renderAll();
  if (line) setTimeout(() => S.tabs[i]?.gotoLine(line, find), 30);
  return S.tabs[i];
}

/** Closing a tab asks first: the × is easy to hit by accident. */
async function askCloseTab(i) {
  const v = S.tabs[i];
  if (!v) return;
  const ok = await confirmDlg(t('Fül bezárása'),
    t('Bezárod a(z) „{0}” fület?\nA jegyzet a lemezen megmarad, később újra megnyithatod.', v.title()), t('Bezárás'));
  const idx = S.tabs.indexOf(v);
  if (ok && idx >= 0) await closeTab(idx);
}

async function closeTab(i, silent = false) {
  const v = S.tabs[i];
  if (!v) return;
  if (!silent && v.isDirty() && !(await v.save())) {
    if (!(await confirmDlg(t('Mentés sikertelen'), t('A(z) „{0}” nem menthető. Bezárod mentés nélkül?', v.title()), t('Bezárás'), true))) return;
  }
  const idx = S.tabs.indexOf(v);
  if (idx < 0) return;
  S.tabs.splice(idx, 1);
  if (S.active >= S.tabs.length) S.active = S.tabs.length - 1;
  else if (idx < S.active) S.active--;
  persistSession();
  renderAll();
}

function switchTab(i) {
  if (i === S.active) return;
  S.active = i;
  persistSession();
  sidebar.draw();
  renderAll();
}

/** Saves every open note (before a sync / on exit). */
async function saveAll() {
  let ok = true;
  for (const v of S.tabs) if (v.isDirty() && !(await v.save())) ok = false;
  return ok;
}

async function askName(title, label, value = '', okLabel = 'OK') {
  const inp = h('input.inp', { value, spellcheck: 'false' });
  const res = await modal({ title, body: h('label.field', h('span', label), inp), buttons: [{ label: t('Mégse'), value: null }, { label: okLabel, value: () => inp.value, primary: true }] });
  return res == null ? null : res.trim();
}

async function newNote(dir = '') {
  const title = await askName(t('Új jegyzet'), dir ? t('Cím (a(z) „{0}” mappában)', dir) : t('Cím'), '', t('Létrehozás'));
  if (title == null) return;
  try {
    const rel = await invoke('create_note', { dir, title });
    await sidebar.refresh();
    const v = await openNote(rel);
    if (v?.ta) { v.ta.focus(); v.ta.setSelectionRange(v.text.length, v.text.length); }
    syncAfterSave();
  } catch (e) { toast(String(e), 'err'); }
}

async function newFolder(parent = '') {
  const name = await askName(t('Új mappa'), parent ? t('Név (a(z) „{0}” mappában)', parent) : t('Név'), '', t('Létrehozás'));
  if (!name) return;
  try {
    const rel = await invoke('create_folder', { parent, name });
    await sidebar.refresh();
    sidebar.reveal(rel + '/x');
  } catch (e) { toast(String(e), 'err'); }
}

/** Open tabs follow a renamed / moved note or folder. */
function retarget(from, to, isDir) {
  for (const v of S.tabs) {
    if (v.rel === from) v.renamed(to);
    else if (isDir && v.rel.startsWith(from + '/')) v.renamed(to + v.rel.slice(from.length));
  }
  retargetStars(from, to, isDir);
  persistSession();
}

async function renameEntry(rel, isDir) {
  const ext = isDir ? '' : extOf(rel);
  const name = await askName(isDir ? t('Mappa átnevezése') : t('Jegyzet átnevezése'), t('Új név'), isDir ? basename(rel) : stemOf(rel), t('Átnevezés'));
  if (!name) return;
  // the extension stays unless a new one is typed
  const file = isDir || !ext || /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}.${ext}`;
  const to = joinRel(dirOf(rel), file);
  if (to === rel) return;
  const v = S.tabs.find((x) => x.rel === rel);
  if (v?.isDirty()) await v.save();
  try {
    await invoke('rename_entry', { from: rel, to });
    retarget(rel, to, isDir);
    await sidebar.refresh();
    renderAll();
    syncAfterSave();
  } catch (e) { toast(String(e), 'err'); }
}

async function moveEntry(from, toDir) {
  const to = joinRel(toDir, basename(from));
  if (to === from) return;
  const isDir = sidebar.entries().some((e) => e.dir && e.rel === from);
  for (const v of S.tabs) if ((v.rel === from || v.rel.startsWith(from + '/')) && v.isDirty()) await v.save();
  try {
    await invoke('rename_entry', { from, to });
    retarget(from, to, isDir);
    await sidebar.refresh();
    sidebar.reveal(to);
    renderAll();
    syncAfterSave();
  } catch (e) { toast(String(e), 'err'); }
}

async function deleteEntry(rel, isDir) {
  const text = isDir ? t('Törlöd a(z) „{0}” mappát és minden jegyzetét? (Lomtárba kerülnek; a szinkron a többi helyről is törli őket.)', rel)
    : t('Törlöd a(z) „{0}” jegyzetet? (Lomtárba kerül; a szinkron a többi helyről is törli.)', stemOf(rel));
  if (!(await confirmDlg(t('Törlés'), text, t('Törlés'), true))) return;
  try {
    await invoke('delete_entry', { rel });
    dropStars(rel, isDir);
    for (let i = S.tabs.length - 1; i >= 0; i--) if (S.tabs[i].rel === rel || (isDir && S.tabs[i].rel.startsWith(rel + '/'))) closeTab(i, true);
    await sidebar.refresh();
    renderAll();
    syncAfterSave();
  } catch (e) { toast(String(e), 'err'); }
}

/** "Keep both" after a save conflict: the text here goes into a new note next to it. */
async function keepBoth(v) {
  const names = new Set(sidebar.entries().map((e) => e.rel.toLowerCase()));
  const ext = extOf(v.rel) ? '.' + extOf(v.rel) : '';
  let rel;
  for (let n = 1; ; n++) {
    rel = joinRel(dirOf(v.rel), `${stemOf(v.rel)} (${t('saját')}${n > 1 ? ' ' + n : ''})${ext}`);
    if (!names.has(rel.toLowerCase())) break;
  }
  try {
    await invoke('write_note', { rel, text: v.text, expect: null, force: true });
    await v.load();
    await sidebar.refresh();
    await openNote(rel, { background: true });
    toast(t('Az itteni változat külön jegyzetbe került: {0}', rel), 'ok', 5000);
    renderAll();
    return true;
  } catch (e) { toast(String(e), 'err'); return false; }
}

// ───────────────────────── sync schedule ─────────────────────────

const syncAfterSave = debounce(() => {
  if (S.settings.sync_on_save && (S.settings.targets || []).some((x) => x.enabled)) syncer.syncAll();
}, 6000);

let lastAuto = Date.now();
function startAutoSync() {
  setInterval(() => {
    const min = S.settings.auto_sync_min || 0;
    if (min > 0 && Date.now() - lastAuto >= min * 60000) { lastAuto = Date.now(); syncer.syncAll(); }
  }, 30000);
}
function syncNow() { lastAuto = Date.now(); syncer.syncAll({ manual: true }); }

async function loadSyncInfo() {
  S.syncInfo = await invoke('sync_info').catch(() => []);
  renderStatusbar();
  renderToolbar();
}

// ───────────────────────── rendering ─────────────────────────

function renderAll() {
  renderTabs();
  renderToolbar();
  renderContent();
  renderStatusbar();
}

function renderTabs() {
  const el = document.getElementById('tabs');
  el.replaceChildren(
    ...S.tabs.map((v, i) => h('div.tab' + (i === S.active ? '.active' : ''), {
      title: v.tooltip(),
      on: {
        mousedown: (e) => { if (e.button === 1) { e.preventDefault(); askCloseTab(i); } },
        click: () => switchTab(i),
        contextmenu: (e) => contextMenu(e, [
          { label: t('Átnevezés…'), icon: 'rename', key: 'F2', action: () => renameEntry(v.rel, false) },
          { label: t('Megjelenítés a mappában'), icon: 'folderOpen', action: () => ctx.reveal(v.rel) },
          '-',
          { label: t('Bezárás'), icon: 'close', key: 'Ctrl+W', action: () => askCloseTab(i) },
          { label: t('A többi bezárása'), action: async () => { for (let k = S.tabs.length - 1; k >= 0; k--) if (S.tabs[k] !== v) await closeTab(k); } },
        ]),
      },
    }, icon(conflictOriginal(v.rel) ? 'warnTri' : 'note'), h('span.name', v.title()), v.isDirty() ? h('span.tab-dirty', { title: t('Nem mentett') }, '●') : null,
    h('button.x', { title: t('Bezárás'), on: { click: (e) => { e.stopPropagation(); askCloseTab(i); } } }, icon('close')))),
    h('button.tab-add', { title: t('Új jegyzet (Ctrl+N)'), on: { click: () => newNote(cur() ? dirOf(cur().rel) : '') } }, icon('plus')),
  );
}

function tb(label, ic, action, { disabled, title, cls = '', badge } = {}) {
  return h('button.tb' + cls, { disabled: disabled || null, title: title || label, on: { click: action } }, icon(ic), h('span', label), badge ? h('span.badge', badge) : null);
}

function syncSummary() {
  const enabled = (S.settings.targets || []).filter((x) => x.enabled);
  const infos = S.syncInfo.filter((i) => enabled.some((x) => x.id === i.id));
  const failed = infos.filter((i) => i.last_sync && !i.ok);
  const last = Math.max(0, ...infos.map((i) => i.last_sync || 0));
  return { enabled, failed, last };
}

function renderToolbar() {
  const el = document.getElementById('toolbar');
  const v = cur();
  const nextTheme = nextBasicTheme();
  const sy = syncSummary();
  const syncing = syncer.isRunning();
  el.replaceChildren(
    h('div.repo-title', { title: v ? v.rel : '' }, h('span.rn', v ? v.title() : 'NoteStar'),
      h('span.rb', icon(v ? 'folder' : 'star'), v ? (dirOf(v.rel) || t('Jegyzetek')) : t('Jegyzetek szinkronban'))),
    h('div.tb-sep'),
    tb(t('Új jegyzet'), 'newNote', () => newNote(v ? dirOf(v.rel) : ''), { title: t('Új jegyzet (Ctrl+N)') }),
    tb(t('Új mappa'), 'newFolder', () => newFolder(v ? dirOf(v.rel) : ''), { title: t('Új mappa (Ctrl+Shift+N)') }),
    tb(t('Mentés'), 'save', () => v.save({ force: false }), { disabled: !v || !v.isDirty(), title: t('Mentés most (Ctrl+S) – egyébként automatikus') }),
    h('div.tb-sep'),
    tb(syncing ? t('Szinkron…') : t('Szinkron'), 'sync', () => syncNow(), {
      cls: syncing ? '.syncing' : '',
      badge: sy.failed.length ? '!' : null,
      title: sy.enabled.length ? t('Szinkronizálás most (F5)') + (sy.last ? '\n' + t('Utolsó: {0}', relTime(sy.last / 1000)) : '') + (sy.failed.length ? '\n' + sy.failed.map((f) => '✗ ' + f.msg).join('\n') : '')
        : t('Nincs szinkron cél – kattints a beállításhoz'),
    }),
    h('div.tb-sep'),
    tb(t('Keresés'), 'search', () => (v ? v.openFind() : sidebar.focusSearch()), { title: t('Keresés a jegyzetben (Ctrl+F) · minden jegyzetben: Ctrl+Shift+F') }),
    tb(t('Előnézet'), 'eye', () => v.setMode(v.mode === 'preview' ? 'edit' : 'preview'), { disabled: !v, title: t('Szerkesztés / előnézet váltás (Ctrl+E)') }),
    aiOn() ? tb('AI', 'sparkle', () => aiNote(), { disabled: !v, title: t('AI asszisztens a jegyzethez (Ctrl+Shift+A)') }) : null,
    h('div.tb-spacer'),
    tb(t(THEME_UI[nextTheme][0]), THEME_UI[nextTheme][1], toggleTheme, { title: t('Váltás sötét és világos téma között (a többi téma a Beállításokban)') }),
    ...(S.donationVisible ? [h('span.tb-donate', tb(t('Adomány'), 'heart', () => openDonate(), { title: t('A NoteStar ingyenes. Ha hasznos neked, egy kis adománnyal támogathatod a fejlesztést.') }))] : []),
    tb(t('Beállítások'), 'settings', () => settingsDlg()),
    tb(t('Névjegy'), 'info', () => aboutDlg(), { title: t('A NoteStar névjegye (F1)') }),
  );
}

function renderStatusbar() {
  const el = document.getElementById('statusbar');
  const v = cur();
  const sy = syncSummary();
  let syncEl;
  if (S.syncText) syncEl = h('span.sync-st', icon('sync', 'spin'), S.syncText);
  else if (!sy.enabled.length) syncEl = h('a', { on: { click: () => settingsDlg('sync') } }, t('Szinkron: nincs beállítva'));
  else if (sy.failed.length) syncEl = h('a.sync-st.err', { title: sy.failed.map((f) => f.msg).join('\n'), on: { click: () => syncNow() } }, icon('warnTri'), t('Szinkron hiba'));
  else syncEl = h('a.sync-st', { title: t('Szinkronizálás most (F5)'), on: { click: () => syncNow() } }, icon('sync'), sy.last ? t('Szinkron: {0}', relTime(sy.last / 1000)) : t('Szinkron: még nem futott'));
  el.replaceChildren(
    S.busy && !S.syncText ? h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, icon('refresh', 'spin'), S.busyLabel || t('Folyamatban…'))
      : h('a.notes-path', { title: t('Jegyzetmappa megnyitása'), on: { click: () => invoke('reveal_in_explorer', { path: S.notesDir }).catch(() => {}) } }, icon('folder'), v ? v.rel : S.notesDir),
    h('span.grow'),
    ...(v ? v.status() : []),
    syncEl,
    zoomNow() !== 1 ? h('span.zoom-status', { title: t('Nagyítás visszaállítása 100%-ra (Ctrl+0)'), on: { click: () => setZoom(1) } }, Math.round(zoomNow() * 100) + '%') : null,
    aiOn() ? aiUsageItem(aiKey() ? aiModel() : t('nincs beállítva')) : null,
    S.update?.updateAvailable ? h('span.update-status', { title: t('Kattints a telepítéshez'), on: { click: () => updateShowAvailable() } }, icon('fetch'), t('Frissítés elérhető: v{0}', S.update.latestVersion)) : null,
  );
}

function renderContent() {
  const el = document.getElementById('content');
  const v = cur();
  if (!v) { renderWelcome(el); return; }
  v.mount(el);
}

function renderWelcome(el) {
  const recent = sidebar.entries().filter((e) => !e.dir && !e.image).sort((a, b) => b.mtime - a.mtime).slice(0, 10);
  const card = (ic, title, desc, key, action) => h('button.wl-card', { on: { click: action } }, icon(ic), h('b', title), h('span', desc), key ? h('kbd', key) : null);
  const hasTargets = (S.settings.targets || []).length > 0;
  el.replaceChildren(h('div.welcome', h('div.welcome-box',
    h('h1', h('img', { src: 'img/icon.svg', alt: '' }), 'NoteStar'),
    h('div.lead', t('Egyszerű szöveges / Markdown jegyzetek, szinkronban a OneDrive-val, Dropboxszal, WebDAV-val vagy bármely mappával.')),
    h('div.wl-cards',
      card('newNote', t('Új jegyzet'), t('Markdown vagy sima szöveg'), 'Ctrl+N', () => newNote('')),
      card('search', t('Keresés'), t('Teljes szöveges keresés minden jegyzetben'), 'Ctrl+Shift+F', () => sidebar.focusSearch()),
      hasTargets ? card('sync', t('Szinkron most'), t('Minden bekapcsolt cél'), 'F5', () => syncNow())
        : card('sync', t('Szinkron beállítása'), t('OneDrive, Dropbox, WebDAV vagy mappa'), null, () => settingsDlg('sync')),
      aiOn() ? card('sparkle', t('AI asszisztens'), t('Összefoglal, javít, fordít, teendőket gyűjt'), 'Ctrl+Shift+A', () => (cur() ? aiNote() : toast(t('Nyiss meg egy jegyzetet.'))))
        : card('folderOpen', t('Jegyzetmappa'), S.notesDir, null, () => invoke('reveal_in_explorer', { path: S.notesDir }).catch((e) => toast(String(e), 'err')))),
    recent.length ? h('div.wl-h', t('Legutóbb módosított jegyzetek')) : null,
    recent.length ? h('div.recent', recent.map((e) => h('div.recent-item', { title: e.rel, on: { click: () => openNote(e.rel) } },
      icon(conflictOriginal(e.rel) ? 'warnTri' : 'note'),
      h('div.ri', h('div', stemOf(e.rel)), h('div.p', (dirOf(e.rel) ? dirOf(e.rel) + ' · ' : '') + relTime(e.mtime / 1000)))))) : null,
  )));
}

// ───────────────────────── AI panel ─────────────────────────

/** The first fenced code block of an answer (the rewritten note), or null. */
function codeBlock(text) {
  const m = String(text).match(/```[\w-]*\n([\s\S]*?)\n?```/);
  return m ? m[1] : null;
}

/**
 * run(question, history) -> {text, truncated}; presets: quick requests;
 * actions(answer) -> buttons shown under each answer.
 */
function aiPanel(title, run, presets = [], actions = () => []) {
  document.querySelector('.ai-panel')?.remove();
  if (!aiOn()) { toast(t('Az AI funkciók ki vannak kapcsolva (Beállítások → AI).'), 'err'); return; }
  if (!aiKey()) {
    toast(t('Az AI funkciókhoz add meg az API kulcsot (vagy válaszd a Claude Code CLI-t) a Beállításokban.'), 'err');
    settingsDlg('ai');
    return;
  }
  const history = [];
  const body = h('div.ai-body');
  const input = h('textarea.inp.ai-ask', { rows: 2, placeholder: t('Kérj valamit a jegyzettel… (Enter: küldés, Shift+Enter: új sor)') });
  const send = h('button.btn.sm.ai', { on: { click: () => ask(input.value.trim()) } }, icon('sparkle'), t('Küldés'));
  let busy = false;
  const ask = async (q) => {
    if (busy) return;
    busy = true;
    send.disabled = true;
    if (q) body.append(h('div.ai-q', q));
    input.value = '';
    const wait = h('div.ai-thinking', icon('sparkle', 'spin'), t('Az AI dolgozik…'));
    body.append(wait);
    wait.scrollIntoView({ block: 'end' });
    try {
      const res = await run(q || null, history.slice());
      wait.remove();
      history.push({ q: q || '', a: res.text });
      const out = h('div.ai-ans', { html: mdRender(res.text) });
      // links open in the browser; the window itself must never navigate
      out.addEventListener('click', (e) => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        if (/^(https?|mailto):/i.test(a.getAttribute('href'))) invoke('open_url', { url: a.getAttribute('href') }).catch((err) => toast(String(err), 'err'));
      });
      const acts = actions(res.text).filter(Boolean);
      body.append(out, acts.length ? h('div.ai-acts', acts.map((a) => h('button.btn.sm' + (a.primary ? '.primary' : ''), { on: { click: () => a.fn() } }, a.icon ? icon(a.icon) : null, a.label))) : null);
      if (res.truncated) body.append(h('div.ai-q', t('Megjegyzés: a jegyzet túl nagy volt, csak az eleje került elemzésre.')));
      out.scrollIntoView({ block: 'start' });
    } catch (e) {
      wait.replaceWith(h('div', { style: { color: 'var(--danger)' } }, String(e)));
    } finally { busy = false; send.disabled = false; input.focus(); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value.trim()); } });
  const panel = h('div.ai-panel',
    h('div.pane-h', h('span.spark', icon('sparkle')), title, h('span.sub', ` · ${aiModel() || aiProviderName()}`), h('span.grow'),
      h('button.icon-btn', { title: t('Szöveg másolása'), on: { click: () => navigator.clipboard.writeText(body.innerText).then(() => toast(t('Vágólapra másolva'), 'ok', 1500)) } }, icon('copy')),
      h('button.icon-btn', { title: t('Bezárás (Esc)'), on: { click: () => panel.remove() } }, icon('close'))),
    body,
    h('div.ai-foot',
      presets.length ? h('div.ai-presets', presets.map((p) => h('button.btn.sm', { on: { click: () => ask(p) } }, p))) : null,
      h('div.ai-askrow', input, send)));
  document.body.append(panel);
  return { ask, input };
}

function aiNote() {
  const v = cur();
  if (!v) return;
  const presets = [
    t('Foglald össze'),
    t('Javítsd a helyesírást és a nyelvtant'),
    t('Írd át világosabbra és tömörebbre'),
    t('Gyűjtsd ki a teendőket checklistába'),
    t('Formázd rendezett Markdownná'),
    getLang() === 'hu' ? 'Fordítsd le angolra' : 'Translate it into Hungarian',
    t('Javasolj címet'),
  ];
  const panel = aiPanel(t('AI – {0}', v.title()),
    (q, history) => invoke('ai_note', { name: v.rel, text: v.text, question: q, history }), presets,
    (answer) => {
      const code = codeBlock(answer);
      return [
        code != null ? { label: t('Csere a jegyzetben'), icon: 'replace', primary: true, fn: () => { if (S.tabs.includes(v)) { v.setText(code); toast(t('A jegyzet frissült (Ctrl+Z: visszavonás).'), 'ok', 2500); } } } : null,
        { label: t('Beszúrás a kurzorhoz'), icon: 'insert', fn: () => { if (S.tabs.includes(v)) { if (v.mode === 'preview') v.setMode('split'); v.insert(code ?? answer); } } },
        { label: t('Hozzáfűzés új jegyzetként'), icon: 'newNote', fn: () => answerToNote(v, code ?? answer) },
      ];
    });
  panel?.input.focus();
}

async function answerToNote(v, text) {
  try {
    const rel = await invoke('create_note', { dir: dirOf(v.rel), title: `${v.title()} – AI` });
    const n = await invoke('read_note', { rel });
    await invoke('write_note', { rel, text: n.text + text, expect: null, force: true });
    await sidebar.refresh();
    await openNote(rel);
  } catch (e) { toast(String(e), 'err'); }
}

/** A sync conflict copy + its original → one merged note. */
async function aiMerge(copyView, origRel) {
  let ours;
  const open = S.tabs.find((x) => x.rel === origRel);
  try { ours = open ? open.text : (await invoke('read_note', { rel: origRel })).text; }
  catch (e) { toast(t('Az eredeti jegyzet nem olvasható: {0}', String(e)), 'err'); return; }
  aiPanel(t('AI összefésülés – {0}', stemOf(origRel)),
    (q, history) => invoke('ai_merge', { name: origRel, ours, theirs: copyView.text, question: q, history }),
    [t('Mi a különbség a két változat között?'), t('Tartsd meg mindkét változat minden sorát')],
    (answer) => {
      const code = codeBlock(answer);
      return code == null ? [] : [{ label: t('Mentés az eredetibe és a másolat törlése'), icon: 'check', primary: true, fn: async () => {
        const v = await openNote(origRel);
        if (!v) return;
        v.setText(code);
        if (!(await v.save())) return;
        try {
          await invoke('delete_entry', { rel: copyView.rel });
          const i = S.tabs.indexOf(copyView);
          if (i >= 0) closeTab(i, true);
          await sidebar.refresh();
          renderAll();
          toast(t('Összefésülve; az ütközés-másolat a lomtárba került.'), 'ok', 3500);
          syncAfterSave();
        } catch (e) { toast(String(e), 'err'); }
      } }];
    });
}

// ───────────────────────── about / donation ─────────────────────────

const DONATE_URL = 'https://www.c64va.pro/register/donate.php';
const SITE_URL = 'https://www.c64va.pro/notestar.html';
function startDonationTimer() {
  let remaining = 10 * 60 * 1000;
  let started = null;
  let timer;
  const update = () => {
    clearTimeout(timer);
    if (started !== null) remaining -= performance.now() - started;
    started = null;
    if (remaining <= 0) {
      S.donationVisible = true;
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      renderToolbar();
    } else if (!document.hidden && document.hasFocus()) {
      started = performance.now();
      timer = setTimeout(update, remaining);
    }
  };
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  update();
}

function openDonate() {
  invoke('open_url', { url: `${DONATE_URL}?lang=${getLang() === 'hu' ? 'hu' : 'en'}` }).catch((e) => toast(String(e), 'err'));
}

async function aboutDlg() {
  let info = {};
  try { info = await invoke('app_info'); } catch (e) { info = {}; }
  const ai = !aiOn() ? t('kikapcsolva') : aiKey() ? `${aiProviderName()} · ${aiModel()}` : t('nincs beállítva');
  const rows = [
    [t('Verzió'), info.version || '?'],
    ['Tauri', info.tauri || '?'],
    [t('Rendszer'), info.os || '?'],
    ['AI', ai],
    [t('Jegyzetmappa'), info.notes_dir || '?'],
    [t('Beállítások fájl'), info.settings_path || '?'],
  ];
  const text = 'NoteStar ' + rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const features = [
    ['note', t('Markdown jegyzetek')], ['eye', t('Élő előnézet')], ['search', t('Teljes szöveges keresés')],
    ['folder', t('Mappa-szinkron')], ['cloud', 'OneDrive'], ['dropbox', 'Dropbox'], ['server', 'WebDAV'],
    ['sparkle', t('Kapcsolható AI')], ['globe', t('Magyar / English')],
  ];
  const body = h('div.about',
    h('div.about-hero',
      h('div.about-logo', h('img', { src: 'img/icon.svg', alt: 'NoteStar' })),
      h('div.about-name', 'NoteStar'),
      h('div.about-ver', `v${info.version || '?'}`),
      h('div.about-tag', t('Egyszerű jegyzetek, szinkronban minden gépeden – OneDrive, Dropbox, WebDAV vagy bármely mappa.'))),
    h('div.about-feats', features.map(([ic, l]) => h('span.about-feat', icon(ic), l))),
    h('div.about-info', rows.map(([k, v]) => [h('span.k', k), h('span.v', { title: v }, v)]),
      h('span.k', t('Weboldal')), h('span.v', h('a.about-link', { title: SITE_URL, on: { click: () => invoke('open_url', { url: SITE_URL }).catch((e) => toast(String(e), 'err')) } }, SITE_URL.replace(/^https:\/\//, '')))),
    h('div.about-foot', t('Rust + Tauri 2. A GitStar testvérprogramja (GitStar, FtpStar, DiffStar). AI: Anthropic Claude (API vagy Claude Code CLI) vagy DeepSeek.')),
    h('div.about-free', t('A NoteStar ingyenes, MIT-licencű. Ha hasznos neked, egy kis adománnyal támogathatod a fejlesztést. Köszönöm!')),
    h('div.about-copy', '© 2026 Zsolt Tarczali'));
  const res = await modal({ title: t('Névjegy'), body, buttons: [
    { label: t('Adomány'), value: 'donate' },
    { label: t('Frissítések keresése'), value: 'update' },
    { label: t('Beállítások mappa'), value: 'folder' },
    { label: t('Másolás'), value: 'copy' },
    { label: t('Bezárás'), value: false, primary: true },
  ] });
  if (res === 'update') checkForAppUpdate();
  if (res === 'donate') openDonate();
  if (res === 'copy') { await navigator.clipboard.writeText(text).catch(() => {}); toast(t('Vágólapra másolva')); }
  if (res === 'folder' && info.settings_path) invoke('reveal_in_explorer', { path: info.settings_path }).catch((e) => toast(String(e), 'err'));
}

// ───────────────────────── settings ─────────────────────────

async function settingsDlg(startTab) {
  const s = S.settings;
  const els = {};
  const fld = (name, label, el, note, full) => { els[name] = el; return h('label.field' + (full ? '.full' : ''), h('span', label), el, note ? h('span.note', note) : null); };
  const sel = (opts, val) => { const e = h('select.inp', opts.map(([v, l]) => h('option', { value: v }, l))); e.value = String(val); return e; };
  const chk = (name, label, val) => { const e = h('input', { type: 'checkbox', checked: !!val }); els[name] = e; return h('label.chk.full', e, label); };

  // ── notes ──
  const defDir = await invoke('default_notes_dir').catch(() => '');
  const notesDir = h('input.inp', { value: s.notes_dir || '', placeholder: defDir, spellcheck: 'false' });
  const browseNotes = h('button.btn', { type: 'button', on: { click: async () => {
    const d = await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: t('Jegyzetmappa'), defaultPath: notesDir.value || defDir } }).catch(() => null);
    if (d) notesDir.value = Array.isArray(d) ? d[0] : d;
  } } }, t('Tallózás…'));

  // ── sync (edited on a copy, committed with Save) ──
  const work = { targets: JSON.parse(JSON.stringify(s.targets || [])) };
  await loadSyncInfo();

  // ── AI (same as GitStar / DiffStar) + on/off switch ──
  const aiEnabled = h('input', { type: 'checkbox', checked: !!s.ai_enabled });
  const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
  const modelSel = sel([...models.map((m) => [m, m]), ['custom', t('Egyéb…')]], models.includes(s.ai_model) ? s.ai_model : 'custom');
  const customModel = h('input.inp', { value: models.includes(s.ai_model) ? '' : s.ai_model, placeholder: 'model id', style: { display: models.includes(s.ai_model) ? 'none' : '' } });
  modelSel.addEventListener('change', () => (customModel.style.display = modelSel.value === 'custom' ? '' : 'none'));
  const key = h('input.inp', { type: 'password', value: s.anthropic_api_key, placeholder: 'sk-ant-…', spellcheck: 'false' });
  const dsModels = ['deepseek-flash', 'deepseek-v4-pro'];
  const dsModel = s.deepseek_model || 'deepseek-flash';
  const dsKey = h('input.inp', { type: 'password', value: s.deepseek_api_key || '', placeholder: 'sk-…', spellcheck: 'false' });
  const dsModelSel = sel([...dsModels.map((m) => [m, m]), ['custom', t('Egyéb…')]], dsModels.includes(dsModel) ? dsModel : 'custom');
  const dsCustom = h('input.inp', { value: dsModels.includes(dsModel) ? '' : dsModel, placeholder: 'model id', style: { display: dsModels.includes(dsModel) ? 'none' : '' } });
  dsModelSel.addEventListener('change', () => (dsCustom.style.display = dsModelSel.value === 'custom' ? '' : 'none'));
  const providerSel = sel([['anthropic', 'Anthropic Claude (API key)'], ['claude-cli', t('Claude Code CLI (saját bejelentkezés)')], ['deepseek', 'DeepSeek']], s.ai_provider || 'anthropic');
  const cliPath = h('input.inp', { value: s.claude_cli_path || '', placeholder: t('üres = megkeresi (PATH, ~/.local/bin, Homebrew, npm)'), spellcheck: 'false' });
  const cliField = h('label.field.full', h('span', t('Claude CLI útvonala')), cliPath,
    h('span.note', t('A telepített Claude Code CLI-t (claude) futtatja a saját bejelentkezéseddel, így itt nem kell API kulcs. Bejelentkezés: futtasd egyszer a „claude” parancsot egy terminálban.')));
  const keyField = h('label.field.full', h('span', t('Anthropic API kulcs')), key, h('span.note', t('A kulcs a NoteStar beállításfájljában tárolódik ezen a gépen. Kulcs: console.anthropic.com')));
  const claudeBox = h('div.settings-sub.full', keyField, cliField,
    h('label.field', h('span', t('Modell')), modelSel, customModel, h('span.note', t('Alapértelmezés: claude-opus-5-5. Gyorsabb/olcsóbb: claude-haiku-5-5.'))));
  const dsBox = h('div.settings-sub.full',
    h('label.field.full', h('span', t('DeepSeek API kulcs')), dsKey, h('span.note', t('A kulcs a NoteStar beállításfájljában tárolódik ezen a gépen. Kulcs: platform.deepseek.com'))),
    h('label.field', h('span', t('Modell')), dsModelSel, dsCustom, h('span.note', t('Alapértelmezés: deepseek-flash. Erősebb: deepseek-v4-pro.'))));
  const syncProvider = () => {
    const ds = providerSel.value === 'deepseek', cli = providerSel.value === 'claude-cli';
    claudeBox.style.display = ds ? 'none' : ''; dsBox.style.display = ds ? '' : 'none';
    keyField.style.display = cli ? 'none' : ''; cliField.style.display = cli ? '' : 'none';
  };
  providerSel.addEventListener('change', syncProvider);
  syncProvider();
  const aiTestOut = h('span.note', '');
  const aiTestBtn = h('button.btn', { on: { click: async () => {
    const ds = providerSel.value === 'deepseek', cli = providerSel.value === 'claude-cli';
    const apiKey = (ds ? dsKey.value : cli ? cliPath.value : key.value).trim();
    const model = ds ? (dsModelSel.value === 'custom' ? dsCustom.value.trim() || 'deepseek-flash' : dsModelSel.value)
      : (modelSel.value === 'custom' ? customModel.value.trim() || 'claude-opus-5-5' : modelSel.value);
    if (!apiKey && !cli) { aiTestOut.className = 'note err'; aiTestOut.textContent = '✗ ' + t('Nincs megadva API kulcs.'); return; }
    aiTestBtn.disabled = true;
    aiTestOut.className = 'note';
    aiTestOut.textContent = t('Tesztelés…');
    try { aiTestOut.textContent = '✓ ' + (await invoke('ai_test', { provider: providerSel.value, apiKey, model })); aiTestOut.className = 'note ok'; }
    catch (e) { aiTestOut.textContent = '✗ ' + e; aiTestOut.className = 'note err'; }
    finally { aiTestBtn.disabled = false; }
  } } }, t('Teszt'));
  const aiBox = h('div.settings-grid.full.ai-box',
    h('label.field.full', h('span', t('AI szolgáltató')), h('div', { style: { display: 'flex', gap: '6px' } }, providerSel, aiTestBtn), aiTestOut),
    claudeBox, dsBox,
    fld('ai_language', t('AI válaszok nyelve'), sel([['hu', t('Magyar')], ['en', 'English']], s.ai_language)),
    h('div.note.full', t('Az AI csak akkor kap adatot, ha te kéred: az aktuális jegyzet szövegét (ütközésnél a két változatot) küldi el a választott szolgáltatónak. Összefoglal, helyesírást javít, átír, fordít, teendőket gyűjt, és szinkron-ütközéseket fésül össze.')));
  const syncAi = () => aiBox.classList.toggle('off', !aiEnabled.checked);
  aiEnabled.addEventListener('change', syncAi);
  syncAi();

  // ── update ──
  const updCheck = h('input', { type: 'checkbox', checked: s.update_check !== false });
  const updServer = h('input.inp', { value: s.update_server || '', placeholder: 'https://www.c64va.pro/', spellcheck: 'false' });
  const saveUpdServer = async () => {
    try { await invoke('update_server_check', { url: updServer.value }); } catch (e) { toast(String(e), 'err'); return; }
    S.settings.update_server = updServer.value.trim();
    await saveSettings();
    checkForAppUpdate();
  };

  const tabs = [
    ['notes', t('Jegyzetek'), h('div.settings-grid',
      h('label.field.full', h('span', t('Jegyzetmappa')), h('div', { style: { display: 'flex', gap: '6px' } }, notesDir, browseNotes),
        h('span.note', t('Itt vannak a jegyzetek sima fájlként (üres = {0}). Bármely szövegszerkesztővel is megnyithatók.', defDir))),
      fld('extensions', t('Jegyzetként kezelt kiterjesztések'), h('input.inp', { value: s.extensions || '', spellcheck: 'false' }), t('Pontosvesszővel elválasztva, pl. md;txt;markdown. * = minden fájl (a szinkron is így szűr).'), true),
      fld('new_note_ext', t('Új jegyzet formátuma'), sel([['md', 'Markdown (.md)'], ['txt', t('Sima szöveg (.txt)')]], s.new_note_ext || 'md')),
      fld('view_mode', t('Alapnézet'), sel([['edit', t('Szerkesztés')], ['split', t('Osztott (szerkesztő + előnézet)')], ['preview', t('Előnézet')]], s.view_mode || 'edit')),
      h('div.settings-sec', t('Szerkesztő')),
      fld('editor_font', t('Betűtípus'), sel([['mono', t('Fix szélességű (kód)')], ['sans', t('Arányos (olvasható szöveg)')]], s.editor_font || 'mono')),
      fld('editor_font_size', t('Betűméret'), h('input.inp', { type: 'number', min: 10, max: 28, value: s.editor_font_size || 14 })),
      chk('editor_wrap', t('Hosszú sorok tördelése'), s.editor_wrap !== false),
      chk('spellcheck', t('Helyesírás-ellenőrzés (a rendszer nyelvén)'), s.spellcheck),
      chk('restore_session', t('Induláskor a legutóbb megnyitott jegyzetek visszaállítása'), s.restore_session !== false))],
    ['sync', t('Szinkron'), h('div.settings-grid',
      h('div.field.full', h('span', t('Szinkron célok')), syncSettingsPane(work, S.syncInfo),
        h('span.note', t('Minden cél kétirányú: ami az egyik oldalon új, módosult vagy törlődött, a másikon is megtörténik. Ha egy jegyzet mindkét helyen módosult, mindkét változat megmarad (ütközés-másolat). A törölt helyi fájlok a lomtárba kerülnek.'))),
      fld('auto_sync_min', t('Automatikus szinkron'), sel([['0', t('Kikapcsolva')], ['1', t('Percenként')], ['2', t('2 percenként')], ['5', t('5 percenként')], ['10', t('10 percenként')], ['15', t('15 percenként')], ['30', t('30 percenként')], ['60', t('Óránként')]], String(s.auto_sync_min ?? 5))),
      h('div'),
      chk('sync_on_start', t('Szinkron induláskor'), s.sync_on_start !== false),
      chk('sync_on_save', t('Szinkron pár másodperccel a jegyzet mentése után'), s.sync_on_save !== false))],
    ['look', t('Megjelenés'), h('div.settings-grid',
      fld('ui_language', t('Felület nyelve'), sel([['auto', t('Automatikus (rendszer)')], ['hu', 'Magyar'], ['en', 'English']], s.ui_language || 'auto')),
      h('div'),
      fld('theme', t('Téma'), sel([['dark', t('Sötét')], ['light', t('Világos')], ['ai', 'Neon'], ['retro', t('Retró (8 bites)')], ['modern', t('Modern (üveg)')], ['modern-dark', t('Modern sötét (üveg)')], ['system', t('Rendszer szerint')]], s.theme)),
      fld('font_size', t('Felület betűmérete'), h('input.inp', { type: 'number', min: 10, max: 20, value: s.font_size })),
      fld('zoom', t('Nagyítás'), sel(ZOOMS.map((z) => [String(z), Math.round(z * 100) + '%']), String(ZOOMS.includes(zoomNow()) ? zoomNow() : 1)),
        t('Gyorsan: Ctrl + / Ctrl − / Ctrl 0, vagy Ctrl + egérgörgő.')))],
    ['ai', 'AI', h('div.settings-grid',
      h('label.chk.full.ai-switch', aiEnabled, h('b', t('AI funkciók bekapcsolása'))),
      h('div.note.full', t('Kikapcsolva a NoteStar semmilyen AI szolgáltatóhoz nem fordul, és az AI gombok sem látszanak.')),
      aiBox)],
    ['update', t('Frissítés'), h('div.settings-grid',
      h('label.chk.full', updCheck, t('Új verzió keresése induláskor')),
      h('label.field.full', h('span', t('Frissítési szerver')), h('div', { style: { display: 'flex', gap: '6px' } }, updServer,
        h('button.btn', { on: { click: () => saveUpdServer() } }, t('Keresés most'))),
        h('span.note', t('Elég a szerver címe (pl. https://www.c64va.pro/), a NoteStar a downloads/NoteStar/ mappában keresi a telepítőket. Más mappához add meg a teljes címét. Üres = alapértelmezett.'))))],
  ];
  const tabBtns = tabs.map(([id, label]) => h('button.stab', { type: 'button', 'data-label': label, on: { click: () => showTab(id) } }, label));
  const panes = h('div.settings-panes', ...tabs.map(([, , el]) => el));
  const showTab = (id) => {
    if (!tabs.some((x) => x[0] === id)) id = 'notes';
    tabs.forEach(([tid, , el], i) => { el.classList.toggle('on', tid === id); tabBtns[i].classList.toggle('on', tid === id); });
    uiSet('ns.settingsTab', id);
  };
  showTab(startTab || uiGet('ns.settingsTab') || 'notes');
  const body = h('div.settings', h('div.settings-tabs', ...tabBtns), panes);
  const ok = await modal({ title: t('Beállítások'), body, wide: true, buttons: [{ label: t('Mégse'), value: false }, { label: t('Mentés'), value: true, primary: true }] });
  if (!ok) return;
  const oldDir = S.notesDir;
  const hadTargets = new Set((s.targets || []).filter((x) => x.enabled).map((x) => x.id));
  Object.assign(S.settings, {
    notes_dir: notesDir.value.trim(),
    extensions: els.extensions.value.trim() || 'md;txt',
    new_note_ext: els.new_note_ext.value,
    view_mode: els.view_mode.value,
    editor_font: els.editor_font.value,
    editor_font_size: Math.max(10, Math.min(28, +els.editor_font_size.value || 14)),
    editor_wrap: els.editor_wrap.checked,
    spellcheck: els.spellcheck.checked,
    restore_session: els.restore_session.checked,
    targets: work.targets,
    auto_sync_min: +els.auto_sync_min.value || 0,
    sync_on_start: els.sync_on_start.checked,
    sync_on_save: els.sync_on_save.checked,
    theme: els.theme.value,
    ui_language: els.ui_language.value,
    font_size: Math.max(10, Math.min(20, +els.font_size.value || 13)),
    zoom: +els.zoom.value || 1,
    ai_enabled: aiEnabled.checked,
    ai_provider: providerSel.value,
    anthropic_api_key: key.value.trim(),
    claude_cli_path: cliPath.value.trim(),
    deepseek_api_key: dsKey.value.trim(),
    deepseek_model: dsModelSel.value === 'custom' ? dsCustom.value.trim() || 'deepseek-flash' : dsModelSel.value,
    ai_model: modelSel.value === 'custom' ? customModel.value.trim() || 'claude-opus-5-5' : modelSel.value,
    ai_language: els.ai_language.value,
    update_check: updCheck.checked,
  });
  applyZoom();
  try { await invoke('update_server_check', { url: updServer.value }); S.settings.update_server = updServer.value.trim(); }
  catch (e) { toast(String(e), 'err'); }
  if (!aiOn()) document.querySelector('.ai-panel')?.remove();
  // another notes folder: the open notes belong to the old one
  const newDir = await (async () => { await saveSettings(); return invoke('notes_dir').catch(() => oldDir); })();
  if (newDir !== oldDir) {
    await saveAll();
    S.tabs = [];
    S.active = -1;
    S.notesDir = newDir;
    persistSession();
  }
  applyLang();
  applyTheme();
  for (const v of S.tabs) if (v.root) v.applyStyle();
  await sidebar.refresh();
  await loadSyncInfo();
  renderAll();
  // a new or re-enabled target syncs at once
  if (S.settings.targets.some((x) => x.enabled && !hadTargets.has(x.id))) syncer.syncAll({ manual: true });
}

// ───────────────────────── self-update ─────────────────────────

let updBusy = false;

function updateDlgEls() {
  let ov = document.getElementById('update-ov');
  if (ov) return ov.els;
  const els = {
    title: h('div.modal-h'), msg: h('div.desc.update-msg'),
    bar: h('div.update-bar-fill'), text: h('div.update-progress-text'),
    skip: h('button.btn', t('Kihagyom ezt a verziót')),
    close: h('button.btn', t('Bezárás')),
    install: h('button.btn.primary', icon('fetch'), t('Telepítés most')),
  };
  els.prog = h('div.update-progress', h('div.update-bar', els.bar), els.text);
  ov = h('div.overlay#update-ov', h('div.modal.update-dlg', els.title, h('div.modal-b', els.msg, els.prog), h('div.modal-f', els.skip, els.close, els.install)));
  ov.els = els;
  const shut = () => { if (!updBusy) { ov.remove(); document.removeEventListener('keydown', onKey, true); } };
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); } }
  els.close.addEventListener('click', shut);
  els.skip.addEventListener('click', () => { S.settings.update_skip = S.update?.latestVersion || ''; saveSettings(); shut(); });
  els.install.addEventListener('click', () => installUpdate());
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  return els;
}

function updateProgress(state, label = '') {
  const els = updateDlgEls();
  els.prog.style.display = state === null ? 'none' : '';
  els.bar.classList.toggle('indet', state === -1);
  els.bar.style.width = state >= 0 ? state + '%' : '';
  els.text.textContent = label;
}

function updateShow({ title, msg, install = false, skip = false, closeLabel = t('Bezárás') }) {
  const els = updateDlgEls();
  els.title.textContent = title;
  els.msg.textContent = msg;
  els.install.style.display = install ? '' : 'none';
  els.skip.style.display = skip ? '' : 'none';
  els.close.textContent = closeLabel;
  els.close.disabled = false;
  if (!install) updateProgress(null);
}

function updateShowAvailable() {
  const u = S.update;
  if (!u?.updateAvailable) return;
  updateShow({ title: t('Új verzió érhető el'),
    msg: t('Elérhető a NoteStar {0} (most: {1}). Letöltöm és telepítem? A NoteStar a telepítés után újraindul.', u.latestVersion, u.currentVersion),
    install: true, skip: true, closeLabel: t('Később') });
  updateProgress(null);
}

async function checkForAppUpdate({ silent = false } = {}) {
  if (updBusy) return;
  if (!silent) { updateShow({ title: t('Frissítések keresése'), msg: t('Új verzió keresése…') }); updateProgress(-1); }
  updBusy = true;
  let info;
  try { info = await invoke('check_for_update'); }
  catch (e) {
    updBusy = false;
    if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('A frissítés ellenőrzése nem sikerült: {0}', String(e)) });
    return;
  }
  updBusy = false;
  S.update = info;
  renderStatusbar();
  if (!info?.supported) { if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('Ezen a platformon nincs automatikus frissítés.') }); return; }
  if (!info.updateAvailable) { if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('A NoteStar naprakész (v{0}).', info.currentVersion) }); return; }
  if (silent && (S.settings.update_skip === info.latestVersion || document.querySelector('.overlay'))) return;
  updateShowAvailable();
}

async function installUpdate() {
  const u = S.update;
  if (updBusy || !u?.updateAvailable) return;
  await saveAll();
  const els = updateDlgEls();
  updBusy = true;
  els.install.style.display = 'none';
  els.skip.style.display = 'none';
  els.close.disabled = true;
  els.msg.textContent = t('A NoteStar {0} letöltése…', u.latestVersion);
  updateProgress(-1);
  let unlisten = null;
  try {
    const mb = (n) => (n / 1048576).toFixed(1);
    unlisten = await window.__TAURI__.event.listen('update-download-progress', ({ payload: { received, total } }) => {
      if (total > 0) updateProgress(Math.min(100, Math.round((received * 100) / total)), `${mb(received)} / ${mb(total)} MB`);
      else updateProgress(-1, `${mb(received)} MB`);
    });
    const res = await invoke('download_and_install_update', { version: u.latestVersion });
    updateProgress(100);
    if (res.restarting) els.msg.textContent = t('A telepítő elindult, a NoteStar most bezárul és újraindul.');
    else {
      updBusy = false;
      updateShow({ title: t('Új verzió érhető el'), msg: t('A telepítő megnyílt ({0}). Fejezd be a telepítést, majd indítsd újra a NoteStart.', res.path) });
    }
  } catch (e) {
    updBusy = false;
    updateShow({ title: t('Új verzió érhető el'), msg: t('A frissítés nem sikerült: {0}', String(e)), install: true });
    updateProgress(null);
  } finally { unlisten?.(); }
}

// ───────────────────────── boot ─────────────────────────

async function boot() {
  try { S.settings = await invoke('get_settings'); }
  catch (e) { S.settings = { theme: 'dark', targets: [], open_notes: [], extensions: 'md;txt' }; toast(String(e), 'err'); }
  S.settings.ui_state ||= {};
  S.settings.targets ||= [];
  initUiState(S.settings.ui_state, debounce(() => saveSettings(), 300));
  applyLang();
  applyTheme();
  if (zoomNow() !== 1) applyZoom();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (S.settings.theme === 'system') { applyTheme(); renderAll(); } });
  S.notesDir = await invoke('notes_dir').catch(() => '');
  splitter(document.getElementById('side-split'), document.getElementById('sidebar'), { min: 180, max: 640, key: 'ns.sideW' });
  await sidebar.refresh();
  renderAll();
  aiUsageInit(() => renderStatusbar());
  startDonationTimer();
  loadSyncInfo();

  // previously open notes
  if (S.settings.restore_session !== false && S.settings.open_notes?.length) {
    const exists = new Set(sidebar.entries().map((e) => e.rel));
    for (const rel of S.settings.open_notes) {
      if (!exists.has(rel)) continue;
      const v = new NoteView(ctx, rel);
      if (await v.load()) S.tabs.push(v);
    }
    S.active = S.tabs.length ? Math.max(0, Math.min(S.tabs.length - 1, S.settings.active_note ?? 0)) : -1;
    renderAll();
    sidebar.draw();
  }

  // notes changed by other programs (or a cloud client): reload on focus
  let lastFocus = 0;
  window.addEventListener('focus', async () => {
    if (Date.now() - lastFocus < 1000) return;
    lastFocus = Date.now();
    await sidebar.refresh();
    forgetImages();
    for (const v of S.tabs) await v.checkExternal();
    if (!cur()) renderContent();
  });

  // save everything before the window closes
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  win?.onCloseRequested(async (e) => {
    if (!S.tabs.some((v) => v.isDirty())) return;
    e.preventDefault();
    if (!(await saveAll())) {
      const res = await modal({ title: t('Mentés sikertelen'), body: h('div.desc', t('Néhány jegyzet nem menthető. Kilépsz mentés nélkül?')),
        buttons: [{ label: t('Mégse'), value: false }, { label: t('Kilépés mentés nélkül'), value: true, danger: true }] });
      if (!res) return;
    }
    await saveSettings();
    win.destroy();
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const k = e.key, c = e.code;
      const dir = (k === '+' || k === '=' || c === 'NumpadAdd') ? 1 : (k === '-' || c === 'NumpadSubtract') ? -1 : (k === '0' || c === 'Numpad0') ? 0 : null;
      if (dir !== null) { e.preventDefault(); zoomStep(dir); return; }
    }
    if (document.querySelector('.overlay')) return;
    const v = cur();
    const key = e.key.toLowerCase();
    const inField = e.target.closest?.('input, textarea:not(.ed-text), [contenteditable="true"]');
    if (e.key === 'F1') { e.preventDefault(); aboutDlg(); }
    else if (e.key === 'F5') { e.preventDefault(); syncNow(); }
    else if (e.key === 'F2' && v && !inField) { e.preventDefault(); renameEntry(v.rel, false); }
    else if (mod && e.shiftKey && key === 'n') { e.preventDefault(); newFolder(v ? dirOf(v.rel) : ''); }
    else if (mod && key === 'n') { e.preventDefault(); newNote(v ? dirOf(v.rel) : ''); }
    else if (mod && e.shiftKey && key === 'f') {
      e.preventDefault();
      // the selected words (editor or preview) are searched everywhere
      let sel = '';
      if (v?.ta && document.activeElement === v.ta) sel = v.ta.value.slice(v.ta.selectionStart, v.ta.selectionEnd);
      else if (v?.findInp && document.activeElement === v.findInp) sel = v.findInp.value;
      else sel = String(getSelection() || '');
      searchAll(sel && !sel.includes('\n') && sel.length < 200 ? sel : '');
    }
    else if (mod && e.shiftKey && key === 'a') { e.preventDefault(); if (aiOn()) aiNote(); }
    else if (mod && key === 'f' && v) { e.preventDefault(); v.openFind(); }
    else if (mod && key === 'd' && v) { e.preventDefault(); toggleStar(v.rel); }
    else if (mod && key === 'e' && v) { e.preventDefault(); v.setMode(v.mode === 'preview' ? 'edit' : 'preview'); }
    else if (mod && key === 's') { e.preventDefault(); saveAll(); }
    else if (mod && key === 'w') { e.preventDefault(); if (S.active >= 0) askCloseTab(S.active); }
    else if (mod && e.key === 'Tab' && S.tabs.length > 1) { e.preventDefault(); switchTab((S.active + (e.shiftKey ? S.tabs.length - 1 : 1)) % S.tabs.length); }
    else if (mod && key === ',') { e.preventDefault(); settingsDlg(); }
    else if (e.key === 'Escape') { const ai = document.querySelector('.ai-panel'); if (ai) ai.remove(); else if (v?.findBar) v.closeFind(); }
  });
  let wheelSum = 0, wheelLast = 0, wheelAt = 0;
  addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLast > 400) wheelSum = 0;
    wheelLast = now;
    wheelSum += e.deltaY;
    if (Math.abs(wheelSum) < 40 || now - wheelAt < 120) return;
    wheelAt = now;
    zoomStep(wheelSum < 0 ? 1 : -1);
    wheelSum = 0;
  }, { passive: false });
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    editMenu(e);
  });
  document.addEventListener('dragstart', (e) => { if (!e.target.closest?.('[draggable="true"]')) e.preventDefault(); });
  // .md / .txt files (or folders) dropped from outside: imported next to the open note
  const filesDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (filesDrag(e) && !document.querySelector('.overlay')) { dragDepth++; document.body.classList.add('drop-files'); } });
  document.addEventListener('dragleave', (e) => { if (filesDrag(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop-files'); } });
  document.addEventListener('dragover', (e) => {
    if (!filesDrag(e)) return;
    e.preventDefault(); // otherwise the webview would open the file itself
    e.dataTransfer.dropEffect = document.querySelector('.overlay') ? 'none' : 'copy';
  });
  // capture phase: runs before a tree row's drop handler stops the event
  const dropDone = () => { dragDepth = 0; document.body.classList.remove('drop-files'); for (const r of document.querySelectorAll('.trow.drop, .side-tree.drop')) r.classList.remove('drop'); };
  document.addEventListener('drop', dropDone, true);
  document.addEventListener('dragend', dropDone, true);
  window.addEventListener('blur', () => { if (document.body.classList.contains('drop-files')) dropDone(); });
  document.addEventListener('drop', (e) => {
    dropDone();
    if (!filesDrag(e)) return;
    e.preventDefault();
    if (document.querySelector('.overlay')) return;
    const v = cur();
    importFiles(droppedFiles(e.dataTransfer), v ? dirOf(v.rel) : '');
  });

  // the star in the editor head follows the stars changed anywhere
  onStars(() => { for (const v of S.tabs) if (v.root) v.drawHead(); });
  startAutoSync();
  if (S.settings.sync_on_start !== false && S.settings.targets.some((x) => x.enabled)) setTimeout(() => { lastAuto = Date.now(); syncer.syncAll(); }, 1500);
  if (S.settings.update_check !== false) setTimeout(() => checkForAppUpdate({ silent: true }), 4000);
}

boot();
