//! Bake an IR into one self-contained HTML file.
//!
//! Lives here rather than in the CLI so the CLI and the desktop app produce
//! byte-identical output — an export is an export, whichever one you used.
//!
//! Nothing in the result points outside itself: the stylesheet, the renderer
//! and three.js are all inlined. three.js rides in as a base64 data URL inside
//! an import map, which resolves under `file://` where a relative module import
//! would be blocked by CORS. That one trick is what removes the need for a
//! server, a bundler, or a network connection to look at a blueprint.

use serde_json::Value;

const THREE: &str = include_str!("../../../vendor/three.module.min.js");
const SHELL_HTML: &str = include_str!("../../../renderer/shell.html");
const SHELL_CSS: &str = include_str!("../../../renderer/shell.css");
const BLUEPRINT_JS: &str = include_str!("../../../renderer/blueprint.js");
const ENTRY_INLINE_JS: &str = include_str!("../../../renderer/entry-inline.js");

pub fn export(ir: &Value) -> String {
    let json = serde_json::to_string_pretty(ir)
        .unwrap_or_else(|_| "{}".into())
        .replace("</script", "<\\u002fscript");

    let three_url = format!("data:text/javascript;base64,{}", b64(THREE.as_bytes()));

    // Both files are ES modules. Concatenating them means dropping the import
    // that would otherwise try to resolve a sibling file which is not there.
    let entry: String = ENTRY_INLINE_JS
        .lines()
        .filter(|l| !l.trim_start().starts_with("import { createBlueprint }"))
        .collect::<Vec<_>>()
        .join("\n");

    let module = format!(
        "{}\n{}",
        BLUEPRINT_JS.replace("</script", "<\\/script"),
        entry.replace("</script", "<\\/script")
    );

    let title = format!(
        "{} — {}",
        ir["meta"]["title"].as_str().unwrap_or("Blueprint"),
        ir["meta"]["repo"].as_str().unwrap_or("")
    );

    // Order matters: the data goes in while the document is still only the
    // shell. Splicing the scripts first would expose their source to the
    // substitutions that follow — including the sentinel they check for.
    let out = SHELL_HTML
        .replace("__TITLE__", &escape_html(&title))
        .replace("__DATA__", &json);

    let out = replace_between(
        &out,
        "<!--__STYLE__-->",
        "<!--__/STYLE__-->",
        &format!("<style>\n{SHELL_CSS}\n</style>"),
    );

    replace_between(
        &out,
        "<!--__SCRIPT__-->",
        "<!--__/SCRIPT__-->",
        &format!(
            "<script type=\"importmap\">{{\"imports\":{{\"three\":\"{three_url}\"}}}}</script>\n\
             <script type=\"module\">\n{module}\n</script>"
        ),
    )
}

/// Swap out everything from `open` to `close` inclusive.
///
/// The shell carries working dev-mode tags between those markers so it can be
/// served and debugged directly. The exporter replaces the whole span rather
/// than just the marker, or those tags would survive into the output and try to
/// fetch sibling files that are not there.
fn replace_between(src: &str, open: &str, close: &str, with: &str) -> String {
    let Some(a) = src.find(open) else { return src.to_string() };
    let Some(rel) = src[a..].find(close) else { return src.to_string() };
    let b = a + rel + close.len();
    format!("{}{}{}", &src[..a], with, &src[b..])
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Minimal base64. Taking a dependency for this would be silly.
fn b64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_reference_vectors() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foob"), "Zm9vYg==");
        assert_eq!(b64(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn export_leaves_no_external_references() {
        let ir = serde_json::json!({
            "codeviz": "1.1",
            "meta": { "repo": "x", "title": "X", "tagline": "y" },
            "stats": [], "groups": [], "nodes": [], "edges": [],
            "narrative": { "tabs": [] }
        });
        let html = export(&ir);
        assert!(!html.contains("./shell.css"), "dev stylesheet link survived");
        assert!(!html.contains("./entry-inline.js"), "dev script tag survived");
        assert!(!html.contains("../vendor/"), "dev importmap survived");
        // the sentinel check inside the entry must not have been substituted
        assert!(html.contains("'__' + 'DATA' + '__'"));
    }
}
