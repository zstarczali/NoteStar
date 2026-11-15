// NoteStar – sync targets (settings UI, sign-in flows) and running the sync.

import { invoke, h, icon, toast, modal, confirmDlg, relTime } from './util.js';
import { t } from './i18n.js';

export const KINDS = {
  folder: { icon: 'folder', name: () => t('Mappa'), label: () => t('Mappa – OneDrive / Dropbox / Google Drive asztali kliens, hálózati meghajtó, USB') },
  onedrive: { icon: 'cloud', name: () => 'OneDrive', label: () => t('OneDrive – Microsoft Graph, saját App ID-val') },
  dropbox: { icon: 'dropbox', name: () => 'Dropbox', label: () => t('Dropbox – API, saját App key-jel') },
  webdav: { icon: 'server', name: () => 'WebDAV', label: () => t('WebDAV – Nextcloud, ownCloud, Synology, …') },
};

export const newTargetId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Short description of where a target points. */
export function targetDetail(tg) {
  if (tg.kind === 'folder') return tg.path || t('nincs mappa megadva');
  if (tg.kind === 'webdav') return `${tg.url || '?'}${tg.path ? ' → ' + tg.path : ''}`;
  const who = tg.refresh_token ? tg.account || t('bejelentkezve') : t('nincs bejelentkezve');
  return `${who} → ${tg.path || '/'}`;
}

const open = (url) => invoke('open_url', { url }).catch((e) => toast(String(e), 'err'));

// ───────────────────────── target dialog ─────────────────────────

/** Edits a copy of `orig` (or a new target). Resolves to the edited target or null. */
export async function targetDlg(orig) {
  const tg = { kind: 'folder', enabled: true, name: '', path: '', client_id: '', refresh_token: '', account: '', url: '', user: '', password: '', ...(orig || {}) };
  if (!tg.id) tg.id = newTargetId();
  let alive = true;
  const cloud = await invoke('detect_cloud_folders').catch(() => []);

  const kindSel = h('select.inp', Object.entries(KINDS).map(([k, v]) => h('option', { value: k }, v.label())));
  kindSel.value = tg.kind;
  const name = h('input.inp', { value: tg.name, placeholder: t('pl. OneDrive jegyzetek'), spellcheck: 'false' });
  const fields = h('div.tg-fields');
  const testOut = h('span.note', '');
  const field = (label, el, note) => h('label.field.full', h('span', label), el, note ? h('span.note', note) : null);
  const inp = (key, ph, type = 'text') => {
    const e = h('input.inp', { value: tg[key] || '', placeholder: ph || '', spellcheck: 'false', type });
    e.addEventListener('input', () => { tg[key] = e.value.trim(); });
    return e;
  };

  const signedBox = () => h('div.tg-signed', tg.refresh_token
    ? [icon('check'), h('span', t('Bejelentkezve: {0}', tg.account || '?')), h('span.grow'),
      h('button.btn.sm', { type: 'button', on: { click: () => { tg.refresh_token = ''; tg.account = ''; draw(); } } }, t('Kijelentkezés'))]
    : [icon('user'), h('span.dim', t('Még nincs bejelentkezve.'))]);

  const onedriveSignIn = async (box) => {
    if (!tg.client_id) { toast(t('Előbb add meg az App ID-t.'), 'err'); return; }
    let dc;
    try { dc = await invoke('onedrive_device_start', { clientId: tg.client_id }); } catch (e) { toast(String(e), 'err'); return; }
    navigator.clipboard.writeText(dc.user_code).catch(() => {});
    open(dc.verification_uri);
    const status = h('span.dim', t('Várakozás a bejelentkezésre…'));
    box.replaceChildren(h('div.tg-code',
      h('div', t('Nyisd meg: {0} és írd be ezt a kódot (a vágólapon van):', dc.verification_uri)),
      h('div.code-big', dc.user_code),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('button.btn.sm', { type: 'button', on: { click: () => open(dc.verification_uri) } }, icon('globe'), t('Megnyitás újra')),
        h('button.btn.sm', { type: 'button', on: { click: () => navigator.clipboard.writeText(dc.user_code) } }, icon('copy'), t('Kód másolása')),
        icon('refresh', 'spin'), status)));
    const until = Date.now() + dc.expires_in * 1000;
    let wait = Math.max(2, dc.interval) * 1000;
    while (alive && Date.now() < until) {
      await new Promise((r) => setTimeout(r, wait));
      if (!alive) return;
      try {
        const r = await invoke('onedrive_device_poll', { clientId: tg.client_id, deviceCode: dc.device_code });
        if (r.status === 'ok') { tg.refresh_token = r.refresh_token; tg.account = r.account; toast(t('Bejelentkezve: {0}', r.account), 'ok'); draw(); return; }
      } catch (e) { toast(String(e), 'err'); draw(); return; }
    }
    if (alive) { toast(t('A kód lejárt, kezdd újra a bejelentkezést.'), 'err'); draw(); }
  };

  const dropboxSignIn = async (box) => {
    if (!tg.client_id) { toast(t('Előbb add meg az App key-t.'), 'err'); return; }
    let a;
    try { a = await invoke('dropbox_auth_start', { appKey: tg.client_id }); } catch (e) { toast(String(e), 'err'); return; }
    open(a.url);
    const code = h('input.inp', { placeholder: t('Az engedélyezés után kapott kód'), spellcheck: 'false' });
    const ok = h('button.btn.primary.sm', { type: 'button', on: { click: async () => {
      if (!code.value.trim()) return;
      ok.disabled = true;
      try {
        const r = await invoke('dropbox_auth_finish', { appKey: tg.client_id, code: code.value.trim(), verifier: a.verifier });
        tg.refresh_token = r.refresh_token; tg.account = r.account;
        toast(t('Bejelentkezve: {0}', r.account), 'ok');
        draw();
      } catch (e) { toast(String(e), 'err'); ok.disabled = false; }
    } } }, t('Kód beváltása'));
    box.replaceChildren(h('div.tg-code',
      h('div', t('A böngészőben engedélyezd a hozzáférést, majd másold ide a Dropbox által mutatott kódot:')),
      h('div', { style: { display: 'flex', gap: '6px' } }, code, ok),
      h('button.btn.sm', { type: 'button', on: { click: () => open(a.url) } }, icon('globe'), t('Engedélyező oldal megnyitása újra'))));
    code.focus();
  };

  function draw() {
    const k = tg.kind;
    const kids = [];
    if (k === 'folder') {
      const p = inp('path', t('pl. C:\\Users\\én\\OneDrive\\Jegyzetek'));
      const browse = h('button.btn', { type: 'button', on: { click: async () => {
        const d = await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: t('Cél mappa'), ...(tg.path ? { defaultPath: tg.path } : {}) } }).catch(() => null);
        if (d) { tg.path = Array.isArray(d) ? d[0] : d; p.value = tg.path; }
      } } }, t('Tallózás…'));
      kids.push(field(t('Cél mappa'), h('div', { style: { display: 'flex', gap: '6px' } }, p, browse),
        t('A jegyzetek ide másolódnak és innen frissülnek. Ha ez egy felhő-kliens (OneDrive, Dropbox, Google Drive, iCloud) mappája, a kliens viszi tovább a többi gépre.')));
      if (cloud.length) {
        kids.push(h('div.field.full', h('span', t('Felismert felhő mappák')), h('div.tg-cloud', cloud.map((c) => h('button.btn.sm', {
          type: 'button', title: c.path,
          on: { click: () => { const sep = c.path.includes('\\') ? '\\' : '/'; tg.path = c.path.replace(/[\\/]$/, '') + sep + 'NoteStar'; p.value = tg.path; if (!name.value.trim()) name.value = c.name; } },
        }, icon(c.name.startsWith('Dropbox') ? 'dropbox' : 'cloud'), c.name)))));
      }
    } else if (k === 'onedrive') {
      kids.push(field(t('Alkalmazás (client) azonosító – App ID'), inp('client_id', '00000000-0000-0000-0000-000000000000'),
        h('span', t('Azure Portal → App registrations → New registration (fióktípus: személyes Microsoft-fiókok is). Authentication → „Allow public client flows” = Yes. API permissions: Microsoft Graph → Files.ReadWrite, offline_access, User.Read (delegated).'), ' ',
          h('a.about-link', { on: { click: () => open('https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade') } }, t('Azure Portal megnyitása')))));
      kids.push(field(t('Mappa a OneDrive-on'), inp('path', '/NoteStar'), t('Ha nem létezik, az első szinkron létrehozza.')));
      const box = h('div.tg-signbox', signedBox());
      kids.push(h('div.field.full', h('span', t('Bejelentkezés')), box,
        h('div', h('button.btn', { type: 'button', on: { click: () => onedriveSignIn(box) } }, icon('user'), tg.refresh_token ? t('Újra bejelentkezés…') : t('Bejelentkezés Microsoft-fiókkal…')))));
    } else if (k === 'dropbox') {
      kids.push(field('App key', inp('client_id', 'abcd1234efgh567'),
        h('span', t('Dropbox App Console → Create app → Scoped access, „App folder” vagy „Full Dropbox”. Permissions: files.metadata.read, files.content.read, files.content.write, account_info.read. Csak az App key kell, a titkos kulcs nem.'), ' ',
          h('a.about-link', { on: { click: () => open('https://www.dropbox.com/developers/apps') } }, t('App Console megnyitása')))));
      kids.push(field(t('Mappa a Dropboxon'), inp('path', '/NoteStar'), t('„App folder” típusú alkalmazásnál az alkalmazás saját mappáján belül értendő.')));
      const box = h('div.tg-signbox', signedBox());
      kids.push(h('div.field.full', h('span', t('Bejelentkezés')), box,
        h('div', h('button.btn', { type: 'button', on: { click: () => dropboxSignIn(box) } }, icon('user'), tg.refresh_token ? t('Újra bejelentkezés…') : t('Bejelentkezés Dropbox-fiókkal…')))));
    } else if (k === 'webdav') {
      kids.push(field(t('WebDAV cím'), inp('url', 'https://cloud.example.com/remote.php/dav/files/USER/'),
        t('Nextcloud: Fájlok → Beállítások (bal alul) → WebDAV cím. Kétlépcsős azonosításnál alkalmazásjelszó kell.')));
      kids.push(h('div.tg-row', field(t('Felhasználó'), inp('user', '')), field(t('Jelszó'), inp('password', '', 'password'))));
      kids.push(field(t('Mappa a szerveren'), inp('path', 'NoteStar'), t('Ha nem létezik, az első szinkron létrehozza.')));
    }
    kids.push(h('div.field.full', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('button.btn', { type: 'button', on: { click: () => test() } }, icon('check'), t('Kapcsolat tesztelése')), testOut)));
    fields.replaceChildren(...kids);
  }

  async function test() {
    testOut.className = 'note';
    testOut.textContent = t('Tesztelés…');
    try {
      const r = await invoke('target_test', { target: { ...tg, name: name.value.trim() } });
      testOut.className = 'note ok';
      testOut.textContent = '✓ ' + t('Elérhető: {0} jegyzet ({1} fájl) a cél helyen.', r.notes, r.files);
    } catch (e) { testOut.className = 'note err'; testOut.textContent = '✗ ' + e; }
  }

  kindSel.addEventListener('change', () => { tg.kind = kindSel.value; if (!tg.path && tg.kind !== 'folder') tg.path = tg.kind === 'webdav' ? 'NoteStar' : '/NoteStar'; draw(); });
  if (!tg.path && tg.kind !== 'folder') tg.path = '/NoteStar';
  draw();

  const body = h('div.tg-dlg',
    h('label.field.full', h('span', t('Típus')), kindSel),
    h('label.field.full', h('span', t('Név')), name),
    fields);
  const ok = await modal({ title: orig ? t('Szinkron cél szerkesztése') : t('Új szinkron cél'), body, wide: true,
    buttons: [{ label: t('Mégse'), value: false }, { label: t('OK'), value: true, primary: true }] });
  alive = false;
  if (!ok) return null;
  tg.name = name.value.trim() || KINDS[tg.kind].name();
  if (tg.kind === 'folder' && !tg.path) { toast(t('Add meg a cél mappát.'), 'err'); return targetDlg(tg); }
  if (tg.kind === 'webdav' && !tg.url) { toast(t('Add meg a WebDAV címet.'), 'err'); return targetDlg(tg); }
  return tg;
}

/** The "Sync" tab of Settings, editing `work.targets` (committed when Settings is saved). */
export function syncSettingsPane(work, info) {
  const list = h('div.tg-list');
  const draw = () => list.replaceChildren(
    ...(work.targets.length ? work.targets.map((tg, i) => {
      const inf = info.find((x) => x.id === tg.id);
      const en = h('input', { type: 'checkbox', checked: tg.enabled, title: t('Bekapcsolva') });
      en.addEventListener('change', () => { tg.enabled = en.checked; });
      return h('div.tg-item',
        en, icon(KINDS[tg.kind]?.icon || 'cloud'),
        h('div.tg-text', h('b', tg.name || KINDS[tg.kind]?.name() || tg.kind), h('span.dim', targetDetail(tg)),
          inf?.last_sync ? h('span.' + (inf.ok ? 'ok' : 'err'), (inf.ok ? '✓ ' : '✗ ') + t('Utolsó szinkron: {0}', relTime(inf.last_sync / 1000)) + (inf.ok ? ` · ${t('{0} jegyzet', inf.files)}` : ` – ${inf.msg}`)) : null),
        h('button.btn.sm', { type: 'button', on: { click: async () => { const r = await targetDlg(tg); if (r) { work.targets[i] = r; draw(); } } } }, icon('edit'), t('Szerkesztés')),
        h('button.icon-btn', { type: 'button', title: t('Törlés'), on: { click: async () => {
          if (await confirmDlg(t('Szinkron cél törlése'), t('Törlöd a(z) „{0}” szinkron célt? A jegyzetek egyik oldalon sem törlődnek, csak a kapcsolat.', tg.name), t('Törlés'), true)) { work.targets.splice(i, 1); draw(); }
        } } }, icon('trash')));
    }) : [h('div.empty-small', t('Még nincs szinkron cél. A jegyzetek csak ezen a gépen vannak.'))]),
    h('div', h('button.btn', { type: 'button', on: { click: async () => { const r = await targetDlg(null); if (r) { work.targets.push(r); draw(); } } } }, icon('plus'), t('Új szinkron cél…'))));
  draw();
  return list;
}

// ───────────────────────── running ─────────────────────────

/**
 * Syncs every enabled target, one after the other.
 * ctx: { settings, flush(): Promise, setBusy(on, label), after(reports), status(text) }
 */
export function createSyncer(ctx) {
  let running = false;
  let again = false;
  const progress = new Map();
  window.__TAURI__?.event?.listen('sync-progress', ({ payload }) => {
    progress.set(payload.id, payload);
    const p = payload;
    ctx.status(p.total ? t('Szinkron: {0}/{1} {2}', Math.min(p.done + 1, p.total), p.total, p.file || '') : t('Szinkron…'));
  });

  async function runOne(tg, manual, force = false) {
    try {
      return await invoke('sync_run', { id: tg.id, force });
    } catch (e) {
      const msg = String(e);
      if (msg === 'SYNC_BUSY') return null;
      const m = msg.match(/^SYNC_MASS_DELETE:(\d+)/);
      if (m) {
        const ok = await confirmDlg(t('Sok törlés'), t('A(z) „{0}” szinkron {1} fájlt törölne (a helyi fájlok a lomtárba kerülnének). Ez lehet szándékos, de egy rossz mappa vagy kiürült tárhely is okozhatja. Folytatod?', tg.name, m[1]), t('Folytatás'), true);
        return ok ? runOne(tg, manual, true) : { skipped: true };
      }
      return { error: msg };
    }
  }

  /** manual: started by the user (always reports); only: one target id */
  async function syncAll({ manual = false, only = null } = {}) {
    const targets = (ctx.settings().targets || []).filter((x) => (only ? x.id === only : x.enabled));
    if (!targets.length) {
      if (manual) toast(t('Nincs bekapcsolt szinkron cél. Állíts be egyet a Beállítások → Szinkron fülön.'), 'err');
      return;
    }
    if (running) { again = true; return; }
    running = true;
    ctx.setBusy(true, t('Szinkron…'));
    const reports = [];
    try {
      await ctx.flush();
      for (const tg of targets) {
        const r = await runOne(tg, manual);
        if (r) reports.push({ target: tg, ...r });
      }
    } finally {
      running = false;
      ctx.setBusy(false);
      ctx.status('');
    }
    await ctx.after(reports);
    report(reports, manual);
    if (again) { again = false; setTimeout(() => syncAll(), 500); }
  }

  function report(reports, manual) {
    for (const r of reports) {
      if (r.error) { toast(`${r.target.name}: ${r.error}`, 'err'); continue; }
      if (r.skipped) continue;
      const parts = [];
      if (r.downloaded) parts.push(t('↓ {0} letöltve', r.downloaded));
      if (r.uploaded) parts.push(t('↑ {0} feltöltve', r.uploaded));
      if (r.deleted_local + r.deleted_remote) parts.push(t('{0} törölve', r.deleted_local + r.deleted_remote));
      if (r.conflicts.length) parts.push(t('{0} ütközés (másolat készült)', r.conflicts.length));
      if (r.errors.length) toast(`${r.target.name}: ${t('{0} hiba', r.errors.length)}\n${r.errors.slice(0, 5).join('\n')}`, 'err');
      if (r.conflicts.length) toast(`${r.target.name}: ${t('Ütközés: mindkét gépen módosult egy jegyzet. A másik változat külön fájlba került:')}\n${r.conflicts.join('\n')}`, 'err', 15000);
      else if (parts.length || manual) toast(`${r.target.name}: ${parts.length ? parts.join(', ') : t('minden naprakész')}`, 'ok', 2500);
    }
  }

  return { syncAll, isRunning: () => running };
}
