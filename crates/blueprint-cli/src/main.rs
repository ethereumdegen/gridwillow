//! `bp` — check, compile, format and export blueprint files.
//!
//!     bp check   infra.bp              parse + validate, report everything
//!     bp build   infra.bp [-o x.json]  compile to the renderer's IR
//!     bp fmt     infra.bp [--write]    canonical formatting
//!     bp export  infra.bp [-o x.html]  one self-contained HTML file

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use blueprint_dsl::{build_lossy, parse};

const USAGE: &str = "\
bp — blueprint files: check, build, format, export

USAGE
    bp check  <file.bp>
    bp build  <file.bp> [-o <out.json>]
    bp fmt    <file.bp> [--write]
    bp export <file.bp> [-o <out.html>]

OPTIONS
    -o <path>   write here instead of the default / stdout
    --write     rewrite the input file in place (fmt only)
    --force     build or export even when there are errors
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let cmd = args[0].clone();
    let positional: Vec<&String> = args[1..].iter().filter(|a| !a.starts_with('-')).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let opt = |name: &str| -> Option<String> {
        let i = args.iter().position(|a| a == name)?;
        args.get(i + 1).cloned()
    };

    let Some(input) = positional.first() else {
        eprintln!("{cmd}: which file?\n\n{USAGE}");
        return ExitCode::from(2);
    };
    let path = PathBuf::from(input);
    let source = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot read {}: {e}", path.display());
            return ExitCode::from(2);
        }
    };
    let shown = path.display().to_string();

    match cmd.as_str() {
        "check" => {
            let out = build_lossy(&source);
            print_report(&out.report, &shown, &source);
            if out.report.has_errors() { ExitCode::FAILURE } else { ExitCode::SUCCESS }
        }

        "build" => {
            let out = build_lossy(&source);
            print_report(&out.report, &shown, &source);
            if out.report.has_errors() && !flag("--force") {
                eprintln!("not compiled — fix the errors above, or pass --force");
                return ExitCode::FAILURE;
            }
            let json = serde_json::to_string_pretty(&out.ir).unwrap();
            match opt("-o") {
                Some(o) => write_out(Path::new(&o), &json),
                None => println!("{json}"),
            }
            ExitCode::SUCCESS
        }

        "fmt" => {
            let (doc, report) = parse::parse(&source);
            if report.has_errors() {
                print_report(&report, &shown, &source);
                eprintln!("not formatted — a file has to parse before it can be tidied");
                return ExitCode::FAILURE;
            }
            let text = blueprint_dsl::emit::emit(&doc);
            if flag("--write") {
                if text == source {
                    eprintln!("{shown} already tidy");
                } else {
                    write_out(&path, &text);
                }
            } else {
                print!("{text}");
            }
            ExitCode::SUCCESS
        }

        "export" => {
            let out = build_lossy(&source);
            print_report(&out.report, &shown, &source);
            if out.report.has_errors() && !flag("--force") {
                eprintln!("not exported — fix the errors above, or pass --force");
                return ExitCode::FAILURE;
            }
            let dest = opt("-o").map(PathBuf::from).unwrap_or_else(|| path.with_extension("html"));
            let html = blueprint_dsl::html::export(&out.ir);
            write_out(&dest, &html);
            let kb = html.len() / 1024;
            let n = out.ir["nodes"].as_array().map(|a| a.len()).unwrap_or(0);
            let e = out.ir["edges"].as_array().map(|a| a.len()).unwrap_or(0);
            eprintln!("      {n} blocks · {e} connections · {kb} KB, self-contained");
            ExitCode::SUCCESS
        }

        other => {
            eprintln!("unknown command `{other}`\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn write_out(path: &Path, text: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(path, text) {
        Ok(()) => eprintln!("wrote {}", path.display()),
        Err(e) => eprintln!("cannot write {}: {e}", path.display()),
    }
}

fn print_report(report: &blueprint_dsl::Report, path: &str, source: &str) {
    let rendered = report.render(path, source);
    if !rendered.trim().is_empty() {
        eprint!("{rendered}");
    }
    let (e, w) = (report.error_count(), report.warning_count());
    if e == 0 && w == 0 {
        eprintln!("ok");
    } else {
        eprintln!("{e} error(s), {w} warning(s)");
    }
}
