//! Real-filesystem test for the NTFS backend. Windows-only, and skips unless
//! DECMPFS_NTFS_DIR points at a writable NTFS dir (the CI job sets it to a temp
//! dir on C:). Unlike btrfs, NTFS's GetCompressedFileSizeW reports the true
//! allocated size, so the on-disk shrink is asserted directly.
#![cfg(windows)]

use std::fs;
use std::path::PathBuf;

use decmpfs::{compress_file, probe, Outcome, Support};

mod common;
use common::fake_addon;

fn ntfs_dir() -> Option<PathBuf> {
  std::env::var_os("DECMPFS_NTFS_DIR").map(PathBuf::from)
}

#[test]
fn compress_file_shrinks_on_ntfs_and_stays_loadable() {
  let Some(dir) = ntfs_dir() else {
    eprintln!("skip: DECMPFS_NTFS_DIR unset");
    return;
  };
  let path = dir.join("raw.node");
  let raw = fake_addon();
  fs::write(&path, &raw).unwrap();

  // ReFS/FAT would report Unsupported; a temp dir on C: is NTFS.
  assert_eq!(probe(&path).unwrap(), Support::Supported, "NTFS detected");

  match compress_file(&path).unwrap() {
    Outcome::Compressed { before, after } => {
      assert!(after < before, "on-disk dropped {before} -> {after}");
      eprintln!("compressed on disk: {before} -> {after}");
    }
    other => panic!("expected Compressed, got {other:?}"),
  }

  // Transparent: reading back yields the identical bytes (still loadable).
  assert_eq!(fs::read(&path).unwrap(), raw);

  // Idempotent: the FILE_ATTRIBUTE_COMPRESSED bit is already set.
  assert!(matches!(
    compress_file(&path).unwrap(),
    Outcome::AlreadyCompressed { .. }
  ));
}
