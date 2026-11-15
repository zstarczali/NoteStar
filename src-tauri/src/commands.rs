//! Tauri commands: everything the UI can ask from the backend.

use crate::settings::{tr, Settings, SettingsStore, Target};
use crate::{ai, dropbox, notes, onedrive, sync};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

pub struct AppState {
    pub settings: SettingsStore,
    /// Documents/NoteStar: the notes folder when none is set
    pub default_notes: PathBuf,
}

impl AppState {
    pub fn notes_dir(&self) -> PathBuf {
        let s = self.settings.get();
        let d = s.notes_dir.trim();
        if d.is_empty() { self.default_notes.clone() } else { PathBuf::from(d) }
    }
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ───────────────────────────── settings ─────────────────────────────

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    // targets that were removed lose their sync state too
    let old = state.settings.get();
    for t in old.targets.iter().filter(|t| !settings.targets.iter().any(|n| n.id == t.id)) {
        sync::forget(&state.settings.dir(), &t.id);
    }
    state.settings.save(settings)
}

/// The UI tells the backend which language to use for its messages.
#[tauri::command]
pub fn set_ui_language(lang: String) {
    crate::settings::set_english(lang == "en");
}

// ───────────────────────────── notes ─────────────────────────────

#[tauri::command]
pub fn notes_dir(state: State<'_, AppState>) -> String {
    state.notes_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn default_notes_dir(state: State<'_, AppState>) -> String {
    state.default_notes.to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn list_notes(state: State<'_, AppState>) -> Result<Vec<notes::Entry>, String> {
    let (root, exts) = (state.notes_dir(), state.settings.get().note_exts());
    blocking(move || notes::list(&root, &exts)).await
}

#[tauri::command]
pub async fn read_note(state: State<'_, AppState>, rel: String) -> Result<notes::Note, String> {
    let root = state.notes_dir();
    blocking(move || notes::read(&root, &rel)).await
}

#[tauri::command]
pub async fn write_note(state: State<'_, AppState>, rel: String, text: String, expect: Option<i64>, force: Option<bool>) -> Result<notes::Saved, String> {
    let root = state.notes_dir();
    blocking(move || notes::write(&root, &rel, &text, expect, force.unwrap_or(false))).await
}

#[tauri::command]
pub async fn create_note(state: State<'_, AppState>, dir: String, title: String) -> Result<String, String> {
    let root = state.notes_dir();
    let ext = state.settings.get().new_note_ext;
    blocking(move || notes::create(&root, &dir, &title, if ext.is_empty() { "md" } else { &ext })).await
}

#[tauri::command]
pub async fn create_folder(state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    let root = state.notes_dir();
    blocking(move || notes::create_dir(&root, &parent, &name)).await
}

#[tauri::command]
pub async fn rename_entry(state: State<'_, AppState>, from: String, to: String) -> Result<(), String> {
    let root = state.notes_dir();
    blocking(move || notes::rename(&root, &from, &to)).await
}

#[tauri::command]
pub async fn delete_entry(state: State<'_, AppState>, rel: String) -> Result<(), String> {
    let root = state.notes_dir();
    blocking(move || notes::delete(&root, &rel)).await
}

#[tauri::command]
pub async fn search_notes(state: State<'_, AppState>, query: String) -> Result<Vec<notes::Hit>, String> {
    let (root, exts) = (state.notes_dir(), state.settings.get().note_exts());
    blocking(move || notes::search(&root, &exts, &query, 300)).await
}

/// Absolute path of a note (for "show in folder" / "open with").
#[tauri::command]
pub fn note_path(state: State<'_, AppState>, rel: String) -> Result<String, String> {
    notes::safe_join(&state.notes_dir(), &rel).map(|p| p.to_string_lossy().into_owned())
}

/// A pasted / dropped image (base64) saved next to note `note`. Returns its path.
#[tauri::command]
pub async fn save_image(state: State<'_, AppState>, note: String, name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let root = state.notes_dir();
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    blocking(move || notes::save_image(&root, &note, &name, &bytes)).await
}

/// An image file picked in a dialog, copied next to note `note`. Returns its path.
#[tauri::command]
pub async fn import_image(state: State<'_, AppState>, note: String, path: String) -> Result<String, String> {
    let root = state.notes_dir();
    blocking(move || notes::import_image(&root, &note, Path::new(&path))).await
}

/// An image of the notes folder as a data: URL (the preview cannot read files itself).
#[tauri::command]
pub async fn image_data(state: State<'_, AppState>, rel: String) -> Result<String, String> {
    let root = state.notes_dir();
    blocking(move || notes::image_data_url(&root, &rel)).await
}

// ───────────────────────────── sync ─────────────────────────────

fn find_target(s: &Settings, id: &str) -> Result<Target, String> {
    s.targets.iter().find(|t| t.id == id).cloned().ok_or_else(|| tr("Ismeretlen szinkron cél.", "Unknown sync target."))
}

/// Syncs the notes with target `id`. Progress: `sync-progress` events.
#[tauri::command]
pub async fn sync_run(app: tauri::AppHandle, state: State<'_, AppState>, id: String, force: Option<bool>) -> Result<sync::Report, String> {
    let s = state.settings.get();
    let target = find_target(&s, &id)?;
    let notes_dir = state.notes_dir();
    let exts = s.sync_exts();
    let state_dir = state.settings.dir();
    let store = &state.settings;
    let progress = |done: usize, total: usize, file: &str| {
        let _ = app.emit("sync-progress", json!({ "id": id, "done": done, "total": total, "file": file }));
    };
    let old = target.refresh_token.clone();
    let tid = target.id.clone();
    let on_token = move |new: &str| store.rotate_token(&tid, &old, new);
    sync::run(sync::Run {
        notes_dir: &notes_dir,
        exts: &exts,
        state_dir: &state_dir,
        target: &target,
        force: force.unwrap_or(false),
        progress: &progress,
        on_token: &on_token,
    })
    .await
}

#[tauri::command]
pub fn sync_info(state: State<'_, AppState>) -> Vec<sync::Info> {
    sync::info(&state.settings.dir(), &state.settings.get().targets)
}

#[derive(Serialize)]
pub struct TestResult {
    pub files: usize,
    pub notes: usize,
}

/// Settings → Sync → Test: connects with the values in the dialog and lists the remote files.
#[tauri::command]
pub async fn target_test(state: State<'_, AppState>, target: Target) -> Result<TestResult, String> {
    let exts = state.settings.get().note_exts();
    let remote = crate::remote::Remote::open(&target, &|_| {}).await?;
    let list = remote.list().await?;
    let notes = list.iter().filter(|f| notes::is_note(f.rel.rsplit('/').next().unwrap_or(&f.rel), &exts)).count();
    Ok(TestResult { files: list.len(), notes })
}

#[tauri::command]
pub async fn onedrive_device_start(client_id: String) -> Result<onedrive::DeviceCode, String> {
    onedrive::device_start(&client_id).await
}

#[tauri::command]
pub async fn onedrive_device_poll(client_id: String, device_code: String) -> Result<onedrive::SignIn, String> {
    onedrive::device_poll(&client_id, &device_code).await
}

#[tauri::command]
pub fn dropbox_auth_start(app_key: String) -> Result<dropbox::AuthStart, String> {
    dropbox::auth_start(&app_key)
}

#[tauri::command]
pub async fn dropbox_auth_finish(app_key: String, code: String, verifier: String) -> Result<dropbox::SignIn, String> {
    dropbox::auth_finish(&app_key, &code, &verifier).await
}

#[derive(Serialize)]
pub struct CloudFolder {
    pub name: String,
    pub path: String,
}

/// Folders of the installed cloud clients (OneDrive, Dropbox, Google Drive, iCloud).
#[tauri::command]
pub fn detect_cloud_folders() -> Vec<CloudFolder> {
    let mut out: Vec<CloudFolder> = vec![];
    let mut add = |name: &str, p: PathBuf| {
        if p.is_dir() && !out.iter().any(|c| Path::new(&c.path) == p) {
            out.push(CloudFolder { name: name.to_string(), path: p.to_string_lossy().into_owned() });
        }
    };
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    for (var, name) in [("OneDriveConsumer", "OneDrive"), ("OneDriveCommercial", "OneDrive (business)"), ("OneDrive", "OneDrive")] {
        if let Some(p) = std::env::var_os(var) {
            add(name, PathBuf::from(p));
        }
    }
    // Dropbox writes its folders to info.json
    let mut infos = vec![];
    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(p) = std::env::var_os(var) {
            infos.push(PathBuf::from(p).join("Dropbox").join("info.json"));
        }
    }
    if let Some(h) = &home {
        infos.push(h.join(".dropbox").join("info.json"));
    }
    for f in infos {
        if let Some(v) = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
            for (k, label) in [("personal", "Dropbox"), ("business", "Dropbox (business)")] {
                if let Some(p) = v[k]["path"].as_str() {
                    add(label, PathBuf::from(p));
                }
            }
        }
    }
    if let Some(h) = &home {
        add("Dropbox", h.join("Dropbox"));
        add("iCloud Drive", h.join("iCloudDrive"));
        add("iCloud Drive", h.join("Library").join("Mobile Documents").join("com~apple~CloudDocs"));
        // macOS: File Provider folders (OneDrive-…, Dropbox, GoogleDrive-…)
        if let Ok(rd) = std::fs::read_dir(h.join("Library").join("CloudStorage")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                let label = if n.starts_with("GoogleDrive") { "Google Drive" } else if n.starts_with("OneDrive") { "OneDrive" } else if n.starts_with("Dropbox") { "Dropbox" } else { continue };
                let p = e.path();
                let my = p.join("My Drive");
                add(label, if my.is_dir() { my } else { p });
            }
        }
    }
    // Windows: Google Drive for desktop mounts a drive letter with "My Drive"
    #[cfg(windows)]
    for letter in b'D'..=b'Z' {
        for name in ["My Drive", "Saját meghajtó"] {
            add("Google Drive", PathBuf::from(format!("{}:\\{name}", letter as char)));
        }
    }
    out
}

// ───────────────────────────── shell helpers ─────────────────────────────

use std::process::Command as Proc;

fn spawn(cmd: &mut Proc) -> Result<(), String> {
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Shows a file (selected) or a folder in the system file manager.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let is_file = Path::new(&path).is_file();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer.exe has its own parser: the quotes must wrap only the path
        let p = path.replace('/', "\\");
        let mut cmd = Proc::new("explorer");
        if is_file { cmd.raw_arg(format!("/select,\"{p}\"")) } else { cmd.raw_arg(format!("\"{p}\"")) };
        spawn(&mut cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Proc::new("open");
        if is_file { cmd.args(["-R", &path]) } else { cmd.arg(&path) };
        spawn(&mut cmd)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let dir = if is_file { Path::new(&path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or(path) } else { path };
        spawn(Proc::new("xdg-open").arg(dir))
    }
}

/// Opens a file with its default application.
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    return spawn(Proc::new("explorer").arg(path.replace('/', "\\")));
    #[cfg(target_os = "macos")]
    return spawn(Proc::new("open").arg(&path));
    #[cfg(not(any(windows, target_os = "macos")))]
    return spawn(Proc::new("xdg-open").arg(&path));
}

/// Opens a web page in the default browser (http(s) only).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err(tr("Érvénytelen webcím.", "Invalid web address."));
    }
    #[cfg(windows)]
    return spawn(Proc::new("rundll32").args(["url.dll,FileProtocolHandler", &url]));
    #[cfg(target_os = "macos")]
    return spawn(Proc::new("open").arg(&url));
    #[cfg(not(any(windows, target_os = "macos")))]
    return spawn(Proc::new("xdg-open").arg(&url));
}

#[tauri::command]
pub fn exe_path() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

// ───────────────────────────── AI ─────────────────────────────

#[derive(Serialize)]
pub struct AiResult {
    pub text: String,
    pub truncated: bool,
}

/// Earlier questions and answers of the AI panel, for follow-up questions.
#[derive(serde::Deserialize, Default)]
pub struct Turn {
    pub q: String,
    pub a: String,
}

fn ai_user(context: String, history: &[Turn], question: Option<String>, default_ask: &str) -> String {
    let mut user = context;
    for t in history {
        user.push_str("\n\nEarlier request: ");
        user.push_str(if t.q.is_empty() { default_ask } else { &t.q });
        user.push_str("\nYour earlier answer:\n");
        user.push_str(&t.a);
    }
    match question.filter(|q| !q.trim().is_empty()) {
        Some(q) => {
            user.push_str("\n\nRequest: ");
            user.push_str(&q);
        }
        None => {
            user.push_str("\n\n");
            user.push_str(default_ask);
        }
    }
    user
}

fn ai_check(cfg: &Settings) -> Result<(), String> {
    if !cfg.ai_enabled {
        return Err(tr("Az AI funkciók ki vannak kapcsolva (Beállítások → AI).", "The AI features are switched off (Settings → AI)."));
    }
    Ok(())
}

async fn ai_run(cfg: &Settings, system: String, user: String) -> Result<String, String> {
    ai::complete(ai::AiRequest {
        provider: &cfg.ai_provider,
        api_key: cfg.ai_key(),
        model: cfg.ai_model_id(),
        system,
        user,
        effort: "medium",
        max_tokens: 16000,
    })
    .await
}

/// Works on one note: summary, corrections, translation, questions…
#[tauri::command]
pub async fn ai_note(
    state: State<'_, AppState>,
    name: String,
    text: String,
    question: Option<String>,
    history: Option<Vec<Turn>>,
) -> Result<AiResult, String> {
    let cfg = state.settings.get();
    ai_check(&cfg)?;
    if text.trim().is_empty() && question.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err(tr("A jegyzet üres – írj bele valamit, vagy kérdezz.", "The note is empty – write something or ask a question."));
    }
    let (body, truncated) = ai::cut_diff(&text, &cfg.ai_provider);
    let mut ctx = format!("NOTE: {name}\n\n<note>\n{body}\n</note>\n");
    if truncated {
        ctx.push_str("\nNote: the note was cut because of its size; say so if it matters.\n");
    }
    let user = ai_user(ctx, &history.unwrap_or_default(), question, ai::NOTE_DEFAULT_ASK);
    let text = ai_run(&cfg, ai::note_system(&cfg.ai_language), user).await?;
    Ok(AiResult { text, truncated })
}

/// Merges a sync conflict copy with the original note.
#[tauri::command]
pub async fn ai_merge(
    state: State<'_, AppState>,
    name: String,
    ours: String,
    theirs: String,
    question: Option<String>,
    history: Option<Vec<Turn>>,
) -> Result<AiResult, String> {
    let cfg = state.settings.get();
    ai_check(&cfg)?;
    let (a, ta) = ai::cut_diff(&ours, &cfg.ai_provider);
    let (b, tb) = ai::cut_diff(&theirs, &cfg.ai_provider);
    let ctx = format!("NOTE: {name}\n\n<version_a source=\"this computer\">\n{a}\n</version_a>\n\n<version_b source=\"conflict copy from the other device\">\n{b}\n</version_b>\n");
    let user = ai_user(ctx, &history.unwrap_or_default(), question, ai::MERGE_DEFAULT_ASK);
    let text = ai_run(&cfg, ai::merge_system(&cfg.ai_language), user).await?;
    Ok(AiResult { text, truncated: ta || tb })
}

/// Settings → AI → Test: a tiny request with the values typed in the dialog.
#[tauri::command]
pub async fn ai_test(provider: String, api_key: String, model: String) -> Result<String, String> {
    let started = std::time::Instant::now();
    let text = ai::complete(ai::AiRequest {
        provider: &provider,
        api_key: &api_key,
        model: &model,
        system: "You are a connection test. Answer with exactly: OK".to_string(),
        user: "Connection test. Answer with exactly: OK".to_string(),
        effort: "low",
        max_tokens: 200,
    })
    .await?;
    let first: String = text.lines().next().unwrap_or("").chars().take(80).collect();
    Ok(format!("{model} · {} ms · „{first}”", started.elapsed().as_millis()))
}

// ───────────────────────────── about ─────────────────────────────

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub tauri: String,
    pub settings_path: String,
    pub notes_dir: String,
    pub os: String,
    pub exe: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        tauri: tauri::VERSION.to_string(),
        settings_path: state.settings.path.to_string_lossy().into_owned(),
        notes_dir: state.notes_dir().to_string_lossy().into_owned(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        exe: exe_path(),
    }
}

// ───────────────────────────── splash screen / window ─────────────────────────────

static SPLASH_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What is remembered of the main window: everything but the visibility
/// (the main window must stay hidden until the splash is over).
pub fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE
}

/// How long the splash screen is shown; the main window appears after it.
pub const SPLASH_TIME: std::time::Duration = std::time::Duration::from_millis(2200);

/// Creates the main window (hidden: `create: false` + `visible: false` in
/// tauri.conf.json), after the splash: two WebView2 windows created at the
/// same moment sometimes left the main one without a page.
pub fn create_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("no 'main' window in tauri.conf.json")?;
    tauri::WebviewWindowBuilder::from_config(app, &cfg)
        .and_then(|b| b.build())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Shows the main window and closes the splash (only the first call counts).
pub fn finish_splash(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(main) = app.get_webview_window("main") else {
        return; // keep the splash: closing the last window would quit the app
    };
    if SPLASH_DONE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let _ = main.show();
    {
        use tauri_plugin_window_state::WindowExt;
        let _ = main.restore_state(window_state_flags());
    }
    let _ = main.set_focus();
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
}

/// Zoom of the whole page (Ctrl + / Ctrl - / Ctrl 0, Ctrl + mouse wheel).
#[tauri::command]
pub fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale.clamp(0.5, 3.0)).map_err(|e| e.to_string())
}

/// Text on the system clipboard (read here: navigator.clipboard.readText()
/// makes the WebView ask the user for permission).
#[tauri::command]
pub fn clipboard_text() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

pub fn save_window_state(app: &tauri::AppHandle) {
    use tauri_plugin_window_state::AppHandleExt;
    let _ = app.save_window_state(window_state_flags());
}

/// Saves the window state shortly after the last move/resize.
pub fn save_window_state_later(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static LAST: AtomicU64 = AtomicU64::new(0);
    static PENDING: AtomicBool = AtomicBool::new(false);
    let now = || SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    LAST.store(now(), Ordering::SeqCst);
    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        while now().saturating_sub(LAST.load(Ordering::SeqCst)) < 1000 {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        PENDING.store(false, Ordering::SeqCst);
        let main = app.clone();
        let _ = app.run_on_main_thread(move || save_window_state(&main));
    });
}
