//! `napi-compress` — the host build-time producer behind `napi build --compress`.
//!
//! Reads a built `.node`, zstd-compresses it, and emits a single self-loading
//! `.node` whose body is the prebuilt stub with a `SMOL/__DECMPFS` section spliced
//! in (the compressed payload + its content hash). On macOS the result is then
//! ad-hoc re-signed so the section stays covered by the code signature — the file
//! is `codesign -v`-clean, notarizable, AND `dlopen`-loadable.
//!
//! This replaces the EOF `NAPCSTUB` trailer, which failed Mach-O strict
//! validation. The section ABI is owned by `decmpfs::section::build_section_payload`.
//!
//! Usage: `napi-compress <stub.node> <raw.node> <out.node> [--level <1..=22>]`.
//! Emits a one-line JSON receipt on stdout and fails LOUD (What/Where/Saw/Fix) on
//! any error, never writing a partial or unsigned output.

// stdout (the JSON receipt) and stderr (the LOUD error) ARE this binary's
// interface — the workspace makes these opt-in, and the producer opts in.
#![allow(clippy::print_stdout, clippy::print_stderr)]

mod inject;

use std::path::PathBuf;
use std::process::ExitCode;

/// zstd level: the producer's only knob. 16 is the sub-1s default; 22 is the
/// smallest blob when build time does not matter. Clamped to this range.
const DEFAULT_LEVEL: i32 = 16;
const MAX_LEVEL: i32 = 22;
const MIN_LEVEL: i32 = 1;

/// The ad-hoc binary identifier stamped when the input carries none. A stable,
/// reverse-DNS name keeps every compressed addon's CodeDirectory identifier
/// consistent without claiming a real signing identity.
const IDENTIFIER: &str = "dev.socket.napi.compressed-addon";

struct Args {
  stub: PathBuf,
  raw: PathBuf,
  out: PathBuf,
  level: i32,
}

fn main() -> ExitCode {
  let args = match parse_args() {
    Ok(args) => args,
    Err(message) => {
      eprintln!("{message}");
      return ExitCode::FAILURE;
    }
  };
  match run(&args) {
    Ok(receipt) => {
      println!("{receipt}");
      ExitCode::SUCCESS
    }
    Err(message) => {
      eprintln!("{message}");
      ExitCode::FAILURE
    }
  }
}

/// Positional `<stub> <raw> <out>` plus an optional `--level <n>`. No clap — the
/// producer is invoked by the CLI with a fixed, validated argument shape.
fn parse_args() -> Result<Args, String> {
  let mut positional: Vec<PathBuf> = Vec::new();
  let mut level = DEFAULT_LEVEL;
  let mut argv = std::env::args().skip(1);
  while let Some(arg) = argv.next() {
    match arg.as_str() {
      "--level" => {
        let value = argv.next().ok_or_else(|| usage("--level needs a value"))?;
        let parsed: i32 = value
          .parse()
          .map_err(|_| usage(&format!("--level value {value:?} is not an integer")))?;
        level = parsed.clamp(MIN_LEVEL, MAX_LEVEL);
      }
      other if other.starts_with("--") => {
        return Err(usage(&format!("unknown flag {other:?}")));
      }
      _ => positional.push(PathBuf::from(arg)),
    }
  }
  let [stub, raw, out] = <[PathBuf; 3]>::try_from(positional)
    .map_err(|got| usage(&format!("expected 3 positional paths, got {}", got.len())))?;
  Ok(Args {
    stub,
    raw,
    out,
    level,
  })
}

fn usage(detail: &str) -> String {
  format!(
    "napi-compress: bad arguments.\n  \
     What:  {detail}\n  \
     Where: napi-compress <stub.node> <raw.node> <out.node> [--level <{MIN_LEVEL}..={MAX_LEVEL}>]\n  \
     Fix:   pass the prebuilt stub, the built addon, and the output path."
  )
}

/// Read raw → hash → compress → build the section body → inject → re-sign → write
/// the output atomically, then print a JSON receipt. Fails LOUD at the first step
/// that cannot complete; never leaves a partial or unsigned `out` on disk.
fn run(args: &Args) -> Result<String, String> {
  let stub = std::fs::read(&args.stub).map_err(|e| {
    fail(
      "cannot read the prebuilt stub",
      &args.stub.display().to_string(),
      &e.to_string(),
      "reinstall @napi-rs/cli or rebuild the stubs (cli/build-stubs.mjs).",
    )
  })?;
  let raw = std::fs::read(&args.raw).map_err(|e| {
    fail(
      "cannot read the built addon",
      &args.raw.display().to_string(),
      &e.to_string(),
      "pass the path to the compiled .node.",
    )
  })?;

  let content_hash = decmpfs::fnv1a64(&raw);
  let payload = zstd::encode_all(&raw[..], args.level).map_err(|e| {
    fail(
      "zstd compression failed",
      &args.raw.display().to_string(),
      &e.to_string(),
      "lower --level or check the input is readable.",
    )
  })?;
  let section_body = decmpfs::section::build_section_payload(content_hash, &payload);

  let injected = inject::inject_decmpfs(&stub, &section_body)
    .map_err(|e| fail("Mach-O section injection failed", &args.stub.display().to_string(), &e, "the stub must have header slack (built with -headerpad,0x1000) and a __LINKEDIT segment."))?;
  let signed = inject::resign(&injected, IDENTIFIER)
    .map_err(|e| fail("ad-hoc re-sign failed", &args.out.display().to_string(), &e, "the injected Mach-O must be well-formed; re-run after a clean stub rebuild."))?;

  write_atomic(&args.out, &signed).map_err(|e| {
    fail(
      "cannot write the output",
      &args.out.display().to_string(),
      &e.to_string(),
      "check the output directory is writable.",
    )
  })?;

  Ok(format!(
    "{{\"rawSize\":{},\"compSize\":{},\"totalSize\":{},\"contentHash\":\"{content_hash:016x}\"}}",
    raw.len(),
    payload.len(),
    signed.len()
  ))
}

/// A four-ingredient error: What / Where / Saw / Fix.
fn fail(what: &str, where_: &str, saw: &str, fix: &str) -> String {
  format!(
    "napi-compress: {what}.\n  \
     Where: {where_}\n  \
     Saw:   {saw}\n  \
     Fix:   {fix}"
  )
}

/// Write to a sibling temp then rename over `out`, so a crash never leaves a
/// half-written (and thus unsigned/unloadable) `.node` at the final path.
fn write_atomic(out: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
  let dir = out.parent().unwrap_or_else(|| std::path::Path::new("."));
  let name = out
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_else(|| "out.node".to_string());
  let tmp = dir.join(format!(".{name}.napi-compress-{}.tmp", std::process::id()));
  std::fs::write(&tmp, data)?;
  std::fs::rename(&tmp, out)
}
