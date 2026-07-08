//! Real-filesystem test for the btrfs backend. Skips unless DECMPFS_BTRFS_DIR
//! points at a mounted btrfs (the Docker harness sets it); never runs on a dev
//! macOS box or ordinary CI. Exercises the PUBLIC surface: probe / compress_file /
//! decmpfs. The on-disk shrink is asserted only on a kernel that actually
//! compresses (some container kernels carry btrfs without working compression).
#![allow(clippy::print_stderr)] // CI diagnostics under --nocapture; not product code

use std::fs;
use std::path::PathBuf;

use decmpfs::{compress_file, probe, resolve_self, Outcome, Support};

mod common;
use common::{fake_addon, stub_with_section};

fn btrfs_dir() -> Option<PathBuf> {
  std::env::var_os("DECMPFS_BTRFS_DIR").map(PathBuf::from)
}

#[test]
fn compress_file_applies_flag_round_trips_and_stays_loadable() {
  let Some(dir) = btrfs_dir() else {
    eprintln!("skip: DECMPFS_BTRFS_DIR unset");
    return;
  };
  let path = dir.join("raw.node");
  let raw = fake_addon();
  fs::write(&path, &raw).unwrap();

  assert_eq!(probe(&path).unwrap(), Support::Supported, "btrfs detected");

  // Compressed is decided by FIEMAP's ENCODED flag, not st_blocks (btrfs reports
  // the logical size via st_blocks, so before == after here even though the data
  // really is compressed on disk — compsize confirms ~3% for this pattern).
  match compress_file(&path).unwrap() {
    Outcome::Compressed { before, after } => {
      eprintln!(
        "FIEMAP-confirmed compressed (st_blocks {before} -> {after}, logical via st_blocks)"
      );
    }
    other => panic!("expected Compressed (FIEMAP ENCODED), got {other:?}"),
  }

  // Transparent: reading back yields the identical bytes (still loadable).
  assert_eq!(fs::read(&path).unwrap(), raw);

  // Flag round-trip on real btrfs: apply_inplace set FS_COMPR_FL and
  // is_already_compressed reads it back, so a second call short-circuits.
  assert!(
    matches!(
      compress_file(&path).unwrap(),
      Outcome::AlreadyCompressed { .. }
    ),
    "second call must detect the compress flag set by the first"
  );
}

#[test]
fn read_only_filesystem_is_skipped_not_errored() {
  let Some(dir) = std::env::var_os("DECMPFS_BTRFS_RO_DIR").map(PathBuf::from) else {
    eprintln!("skip: DECMPFS_BTRFS_RO_DIR unset");
    return;
  };
  let path = dir.join("ro.node");
  // Detection still reports Supported (it IS btrfs), but the write can't happen on
  // a read-only mount — fail-soft turns that into Skipped, never an Err.
  match compress_file(&path).unwrap() {
    Outcome::Skipped { reason } => eprintln!("read-only -> Skipped({reason:?})"),
    other => panic!("expected Skipped on a read-only fs, got {other:?}"),
  }
}

#[test]
fn resolve_self_rewrites_the_stub_in_place_on_btrfs() {
  let Some(dir) = btrfs_dir() else {
    eprintln!("skip: DECMPFS_BTRFS_DIR unset");
    return;
  };

  let path = dir.join("addon.node");
  let raw = fake_addon();
  let composite = stub_with_section(&raw);
  fs::write(&path, &composite).unwrap();

  // On btrfs (Supported), resolve_self rewrites self_path IN PLACE into the raw
  // FS-compressed addon (so future processes dlopen it directly, no stub) and hands
  // this process a loadable cache copy (it can't reload the in-flight self_path).
  let loaded = resolve_self(&path).expect("resolve_self on btrfs");
  assert_eq!(
    fs::read(&path).unwrap(),
    raw,
    "self_path is now the raw addon"
  );
  // FS-compress flag round-tripped: the file is compressed on disk, so a direct
  // compress_file sees it already compressed.
  assert!(
    matches!(
      compress_file(&path).unwrap(),
      Outcome::AlreadyCompressed { .. }
    ),
    "self-rewritten file must be FS-compressed"
  );
  // The returned path is the loadable cache copy, not self_path.
  assert_ne!(loaded, path, "current process loads from the cache");
  assert_eq!(fs::read(&loaded).unwrap(), raw, "cache holds the raw addon");
}
