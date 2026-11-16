mod ai;
mod claude_cli;
mod commands;
mod dropbox;
mod notes;
mod onedrive;
mod remote;
mod settings;
mod sync;
mod update;
mod usage;
mod webdav;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // a second launch brings the running NoteStar to the front instead of a second window
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    // macOS: only the application menu and Edit (needed for Cmd+C/V/X/A/Z).
    #[cfg(target_os = "macos")]
    let builder = builder.enable_macos_default_menu(false).menu(|app| {
        use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
        let app_menu = Submenu::with_items(app, "NoteStar", true, &[
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ])?;
        let edit = Submenu::with_items(app, "Edit", true, &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ])?;
        Menu::with_items(app, &[&app_menu, &edit])
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(commands::window_state_flags())
                .with_denylist(&["splashscreen"])
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("NoteStar"));
            usage::init(app.handle().clone(), dir.clone());
            let docs = app
                .path()
                .document_dir()
                .or_else(|_| app.path().home_dir())
                .unwrap_or_else(|_| std::env::temp_dir());
            let state = AppState { settings: settings::SettingsStore::load(dir), default_notes: docs.join("NoteStar") };
            let _ = std::fs::create_dir_all(state.notes_dir());
            app.manage(state);
            let started = std::time::Instant::now();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                if let Err(e) = commands::create_main_window(&handle) {
                    eprintln!("NoteStar: could not create the main window: {e}");
                }
                std::thread::sleep(commands::SPLASH_TIME.saturating_sub(started.elapsed()));
                commands::finish_splash(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "splashscreen" && matches!(event, tauri::WindowEvent::Destroyed) {
                commands::finish_splash(window.app_handle());
            }
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { .. } => commands::save_window_state(window.app_handle()),
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        commands::save_window_state_later(window.app_handle())
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            usage::ai_usage,
            usage::ai_usage_reset,
            commands::get_settings,
            commands::save_settings,
            commands::set_ui_language,
            commands::notes_dir,
            commands::default_notes_dir,
            commands::list_notes,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::create_folder,
            commands::rename_entry,
            commands::delete_entry,
            commands::search_notes,
            commands::import_note,
            commands::note_path,
            commands::save_image,
            commands::import_image,
            commands::image_data,
            commands::sync_run,
            commands::sync_info,
            commands::target_test,
            commands::onedrive_device_start,
            commands::onedrive_device_poll,
            commands::dropbox_auth_start,
            commands::dropbox_auth_finish,
            commands::detect_cloud_folders,
            commands::reveal_in_explorer,
            commands::open_file,
            commands::open_url,
            commands::exe_path,
            commands::ai_note,
            commands::ai_merge,
            commands::ai_test,
            commands::app_info,
            commands::set_zoom,
            commands::clipboard_text,
            update::check_for_update,
            update::download_and_install_update,
            update::update_server_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NoteStar");
}
