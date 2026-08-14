//! Assemble the webview's asset directory, then run tauri-build.
//!
//! `renderer/` is the single source of truth for the drawing — the exported
//! HTML and this app run the same code. Rather than duplicate those files under
//! the app, we copy them into `app/dist/` at build time and rewrite the shell's
//! two dev-mode tags for app mode. That keeps one renderer, and makes it
//! impossible for the app and the export to drift apart.

use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest.parent().unwrap().parent().unwrap();
    let renderer = repo.join("renderer");
    let dist = manifest.parent().unwrap().join("dist");

    fs::create_dir_all(&dist).expect("create app/dist");

    for f in ["blueprint.js", "entry-app.js", "shell.css"] {
        copy(&renderer.join(f), &dist.join(f));
        println!("cargo:rerun-if-changed={}", renderer.join(f).display());
    }
    copy(
        &repo.join("vendor/three.module.min.js"),
        &dist.join("three.module.min.js"),
    );

    // The shell ships with tags that work when it is served straight from
    // renderer/. Point them at the app's flattened dist instead.
    let shell_src = renderer.join("shell.html");
    println!("cargo:rerun-if-changed={}", shell_src.display());
    let shell = fs::read_to_string(&shell_src).expect("read shell.html");
    let shell = shell
        .replace("__TITLE__", "Blueprint")
        // no data is baked in; Rust pushes it over an event instead
        .replace("__DATA__", "null")
        .replace(
            r#"<script type="importmap">{"imports":{"three":"../vendor/three.module.min.js"}}</script>"#,
            r#"<script type="importmap">{"imports":{"three":"./three.module.min.js"}}</script>"#,
        )
        .replace(
            r#"<script type="module" src="./entry-inline.js"></script>"#,
            r#"<script type="module" src="./entry-app.js"></script>"#,
        );
    fs::write(dist.join("index.html"), shell).expect("write index.html");

    tauri_build::build()
}

fn copy(from: &Path, to: &Path) {
    fs::copy(from, to).unwrap_or_else(|e| panic!("copy {} -> {}: {e}", from.display(), to.display()));
}
