//! Blueprint — the desktop viewer.
//!
//! Rust owns the file: it reads the `.bp`, compiles it, watches it, and pushes
//! a fresh IR into the webview every time it changes. The webview owns nothing
//! but the drawing.
//!
//! The live-reload loop is the reason the app exists. Editing a blueprint is
//! writing prose about a system, and prose needs a fast feedback cycle: save in
//! your editor, look at the window, keep typing. Everything here serves that —
//! including keeping the last good drawing on screen when the file stops
//! parsing, so a half-typed line does not blank the window.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The file currently on screen.
#[derive(Default)]
struct Open {
    path: Option<PathBuf>,
    ir: Option<Value>,
}

#[derive(Default)]
struct App {
    open: Mutex<Open>,
    /// Held so the watcher thread stays alive; replaced on each open.
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
struct Loaded {
    ir: Value,
    path: String,
    warnings: Vec<String>,
}

#[derive(Serialize, Clone)]
struct Failed {
    rendered: String,
    path: String,
    /// True when there is nothing usable to draw, so the window should say so
    /// rather than keep showing a stale picture.
    fatal: bool,
}

/// Compile a file and tell the webview what happened.
///
/// Errors are pushed as an event rather than returned, because a reload is not
/// a call — nobody is waiting on the other end when the trigger was you hitting
/// save in another window.
fn load_and_emit(app: &AppHandle, path: &Path, first_load: bool) {
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit(
                "blueprint://error",
                Failed {
                    rendered: format!("cannot read {}: {e}", path.display()),
                    path: path.display().to_string(),
                    fatal: true,
                },
            );
            return;
        }
    };

    let shown = path.display().to_string();
    let out = gridwillow::build_lossy(&source);

    if out.report.has_errors() {
        let _ = app.emit(
            "blueprint://error",
            Failed {
                rendered: out.report.render(&shown, &source),
                path: shown.clone(),
                // On the very first load there is no previous drawing to fall
                // back to, so an error has to take over the window.
                fatal: first_load,
            },
        );
        if first_load {
            return;
        }
    }

    let warnings: Vec<String> = out.report.warnings().map(|w| w.to_string()).collect();

    if let Some(state) = app.try_state::<App>() {
        let mut open = state.open.lock().unwrap();
        open.path = Some(path.to_path_buf());
        open.ir = Some(out.ir.clone());
    }

    if let Some(w) = app.get_webview_window("main") {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let title = out.ir["meta"]["title"].as_str().unwrap_or("Blueprint");
        let _ = w.set_title(&format!("{title} — {name}"));
    }

    let _ = app.emit(
        "blueprint://loaded",
        Loaded { ir: out.ir, path: shown, warnings },
    );
}

/// Watch the file and recompile on change.
///
/// Editors rarely write a file once: many truncate, write, then rename, which
/// produces a burst of events. Coalescing on a short quiet period turns that
/// burst into a single reload — without it you would recompile three times and
/// briefly render a zero-length file.
fn watch(app: AppHandle, path: PathBuf) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })?;

    // Watch the containing directory: a rename-into-place replaces the inode,
    // and a watch on the file itself would be left pointing at the old one.
    let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;

    let target = path.clone();
    let pending = Arc::new(Mutex::new(None::<Instant>));
    let p2 = pending.clone();

    std::thread::spawn(move || {
        for res in rx {
            let Ok(ev) = res else { continue };
            if !ev.paths.iter().any(|p| p == &target) {
                continue;
            }
            *p2.lock().unwrap() = Some(Instant::now());
        }
    });

    std::thread::spawn(move || {
        const QUIET: Duration = Duration::from_millis(120);
        loop {
            std::thread::sleep(Duration::from_millis(60));
            let due = {
                let mut g = pending.lock().unwrap();
                match *g {
                    Some(t) if t.elapsed() >= QUIET => {
                        *g = None;
                        true
                    }
                    _ => false,
                }
            };
            if due {
                load_and_emit(&app, &path, false);
            }
        }
    });

    Ok(watcher)
}

#[tauri::command]
fn open_blueprint(app: AppHandle, state: State<App>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("{path} is not a file"));
    }
    load_and_emit(&app, &p, true);
    match watch(app.clone(), p) {
        Ok(w) => {
            *state.watcher.lock().unwrap() = Some(w);
            Ok(())
        }
        // A failed watch is not a failed open: you still get the drawing, you
        // just have to reload it yourself.
        Err(e) => Err(format!("opened, but not watching: {e}")),
    }
}

#[tauri::command]
fn current_blueprint(state: State<App>) -> Option<Loaded> {
    let open = state.open.lock().unwrap();
    Some(Loaded {
        ir: open.ir.clone()?,
        path: open.path.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
        warnings: vec![],
    })
}

#[tauri::command]
fn export_html(state: State<App>, dest: String) -> Result<String, String> {
    let open = state.open.lock().unwrap();
    let ir = open.ir.as_ref().ok_or("nothing is open")?;
    let html = gridwillow::html::export(ir);
    std::fs::write(&dest, &html).map_err(|e| format!("cannot write {dest}: {e}"))?;
    Ok(format!("{dest} — {} KB, self-contained", html.len() / 1024))
}

/// Ask for a file, then open it. Kept on the Rust side so the menu and the
/// webview reach the same code path.
fn pick_and_open(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Blueprint", &["bp"])
        .pick_file(move |chosen| {
            if let Some(f) = chosen
                && let Ok(p) = f.into_path() {
                    let h = handle.clone();
                    let state = h.state::<App>();
                    let _ = open_blueprint(h.clone(), state, p.display().to_string());
                }
        });
}

fn pick_and_export(app: &AppHandle) {
    let handle = app.clone();
    let suggested = {
        let state = app.state::<App>();
        let open = state.open.lock().unwrap();
        open.path
            .as_ref()
            .and_then(|p| p.file_stem().map(|s| format!("{}.html", s.to_string_lossy())))
            .unwrap_or_else(|| "blueprint.html".into())
    };
    app.dialog()
        .file()
        .set_file_name(&suggested)
        .add_filter("HTML", &["html"])
        .save_file(move |chosen| {
            if let Some(f) = chosen
                && let Ok(p) = f.into_path() {
                    let state = handle.state::<App>();
                    match export_html(state, p.display().to_string()) {
                        Ok(msg) => {
                            let _ = handle.emit("blueprint://exported", msg);
                        }
                        Err(e) => {
                            let _ = handle.emit("blueprint://error", Failed {
                                rendered: e,
                                path: String::new(),
                                fatal: false,
                            });
                        }
                    }
                }
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(App::default())
        .invoke_handler(tauri::generate_handler![
            open_blueprint,
            current_blueprint,
            export_html
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_menu(&handle)?;

            // A path on argv means the app was launched by opening a .bp —
            // from the shell, or by double-clicking one in Finder.
            if let Some(arg) = std::env::args().nth(1) {
                let p = PathBuf::from(&arg);
                if p.is_file() {
                    let h = handle.clone();
                    // after setup, so the webview is listening
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(250));
                        let state = h.state::<App>();
                        let _ = open_blueprint(h.clone(), state, p.display().to_string());
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running blueprint");
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let open = MenuItem::with_id(app, "open", "Open Blueprint…", true, Some("CmdOrCtrl+O"))?;
    let export = MenuItem::with_id(app, "export", "Export HTML…", true, Some("CmdOrCtrl+E"))?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&open, &PredefinedMenuItem::separator(app)?, &reload, &export],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&file, &edit])?;
    app.set_menu(menu)?;

    app.on_menu_event(move |app, event| match event.id().as_ref() {
        "open" => pick_and_open(app),
        "export" => pick_and_export(app),
        "reload" => {
            let state = app.state::<App>();
            let path = state.open.lock().unwrap().path.clone();
            if let Some(p) = path {
                load_and_emit(app, &p, false);
            }
        }
        _ => {}
    });
    Ok(())
}
