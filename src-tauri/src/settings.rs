//! Persistent settings (app config dir / settings.json).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Language of backend messages (errors shown in the UI). Set by the UI.
static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_english(on: bool) {
    ENGLISH.store(on, Ordering::Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// Picks the Hungarian or the English text.
pub fn tr(hu: &str, en: &str) -> String {
    if is_english() { en.to_string() } else { hu.to_string() }
}

/// One place the notes are kept in sync with.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Target {
    /// Stable id (also the name of the sync state file)
    pub id: String,
    pub name: String,
    /// "folder" | "onedrive" | "dropbox" | "webdav"
    pub kind: String,
    pub enabled: bool,
    /// folder: the local (synced) folder; others: the remote folder, e.g. "/NoteStar"
    pub path: String,
    /// OneDrive: application (client) id; Dropbox: app key
    pub client_id: String,
    /// OneDrive / Dropbox OAuth refresh token
    pub refresh_token: String,
    /// Signed-in account shown in the UI
    pub account: String,
    /// WebDAV server address
    pub url: String,
    pub user: String,
    pub password: String,
}

impl Default for Target {
    fn default() -> Self {
        Target {
            id: String::new(),
            name: String::new(),
            kind: "folder".into(),
            enabled: true,
            path: String::new(),
            client_id: String::new(),
            refresh_token: String::new(),
            account: String::new(),
            url: String::new(),
            user: String::new(),
            password: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// "dark" | "light" | "ai" | "retro" | "modern" | "modern-dark" | "system"
    pub theme: String,
    /// "auto" | "hu" | "en"
    pub ui_language: String,
    pub font_size: u32,
    /// Zoom of the whole UI (1.0 = 100%)
    pub zoom: f64,

    // ── notes ──
    /// The notes folder; empty = Documents/NoteStar
    pub notes_dir: String,
    /// Extensions treated as notes, separated by `;` (`*` = every file)
    pub extensions: String,
    /// Extension of new notes ("md" | "txt")
    pub new_note_ext: String,
    /// "mono" | "sans"
    pub editor_font: String,
    pub editor_font_size: u32,
    pub editor_wrap: bool,
    pub spellcheck: bool,
    /// "edit" | "split" | "preview"
    pub view_mode: String,
    /// "modified" | "name"
    pub sort: String,
    pub open_notes: Vec<String>,
    pub active_note: i32,
    pub restore_session: bool,

    // ── sync ──
    pub targets: Vec<Target>,
    /// Automatic sync every N minutes (0 = off)
    pub auto_sync_min: u32,
    pub sync_on_start: bool,
    /// Sync a few seconds after a note was saved
    pub sync_on_save: bool,

    // ── AI ──
    /// AI features are shown only when switched on
    pub ai_enabled: bool,
    /// "anthropic" | "deepseek" | "claude-cli"
    pub ai_provider: String,
    pub claude_cli_path: String,
    pub anthropic_api_key: String,
    pub ai_model: String,
    pub deepseek_api_key: String,
    pub deepseek_model: String,
    /// "hu" | "en"
    pub ai_language: String,

    // ── update ──
    pub update_server: String,
    pub update_check: bool,
    pub update_skip: String,

    /// UI layout state saved by the frontend (panel sizes, open folders...)
    pub ui_state: HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            ui_language: "auto".into(),
            font_size: 13,
            zoom: 1.0,
            notes_dir: String::new(),
            extensions: "md;txt;markdown".into(),
            new_note_ext: "md".into(),
            editor_font: "mono".into(),
            editor_font_size: 14,
            editor_wrap: true,
            spellcheck: false,
            view_mode: "edit".into(),
            sort: "modified".into(),
            open_notes: vec![],
            active_note: -1,
            restore_session: true,
            targets: vec![],
            auto_sync_min: 5,
            sync_on_start: true,
            sync_on_save: true,
            ai_enabled: false,
            ai_provider: "anthropic".into(),
            claude_cli_path: String::new(),
            anthropic_api_key: String::new(),
            ai_model: "claude-opus-5-5".into(),
            deepseek_api_key: String::new(),
            deepseek_model: "deepseek-flash".into(),
            ai_language: "hu".into(),
            update_server: String::new(),
            update_check: true,
            update_skip: String::new(),
            ui_state: HashMap::new(),
        }
    }
}

impl Settings {
    /// API key of the selected AI provider (the CLI path for "claude-cli").
    pub fn ai_key(&self) -> &str {
        match self.ai_provider.as_str() {
            "deepseek" => &self.deepseek_api_key,
            "claude-cli" => &self.claude_cli_path,
            _ => &self.anthropic_api_key,
        }
    }

    /// Model id of the selected AI provider.
    pub fn ai_model_id(&self) -> &str {
        if self.ai_provider == "deepseek" { &self.deepseek_model } else { &self.ai_model }
    }

    /// The note extensions in lower case, without dots; empty = every file.
    pub fn note_exts(&self) -> Vec<String> {
        let list: Vec<String> = self
            .extensions
            .split([';', ',', ' '])
            .map(|e| e.trim().trim_start_matches("*.").trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        if list.iter().any(|e| e == "*") { vec![] } else { list }
    }
}

pub struct SettingsStore {
    pub path: PathBuf,
    pub data: Mutex<Settings>,
    /// Refresh tokens replaced by the provider during a sync (old → new). The UI
    /// may still hold the old one in its copy of the settings; saving it back
    /// must not undo the rotation.
    rotated: Mutex<HashMap<String, String>>,
}

impl SettingsStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("settings.json");
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();
        SettingsStore { path, data: Mutex::new(data), rotated: Mutex::new(HashMap::new()) }
    }

    pub fn dir(&self) -> PathBuf {
        self.path.parent().map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
    }

    pub fn get(&self) -> Settings {
        self.data.lock().unwrap().clone()
    }

    pub fn save(&self, mut s: Settings) -> Result<(), String> {
        {
            let rot = self.rotated.lock().unwrap();
            for t in &mut s.targets {
                while let Some(new) = rot.get(&t.refresh_token) {
                    t.refresh_token = new.clone();
                }
            }
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
        // write + rename: a crash in the middle never leaves a half settings file
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        *self.data.lock().unwrap() = s;
        Ok(())
    }

    /// A provider gave a new refresh token for target `id`: remember and save it.
    pub fn rotate_token(&self, id: &str, old: &str, new: &str) {
        if old == new || new.is_empty() {
            return;
        }
        self.rotated.lock().unwrap().insert(old.to_string(), new.to_string());
        let mut s = self.get();
        if let Some(t) = s.targets.iter_mut().find(|t| t.id == id) {
            t.refresh_token = new.to_string();
        }
        let _ = self.save(s);
    }
}
