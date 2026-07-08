//! Shared fixtures for the real-filesystem integration tests (btrfs, ntfs, apfs).
//! Not every test uses every helper, so dead_code is expected per test binary.
#![allow(dead_code)]

use decmpfs::fnv1a64;
use decmpfs::section::build_section_payload;

/// ELF magic + a compressible (non-zero, so it isn't stored as a sparse hole)
/// 2 MiB body — large enough for a real on-disk compression measurement.
pub fn fake_addon() -> Vec<u8> {
  let mut raw = vec![0x7f, 0x45, 0x4c, 0x46];
  let pattern = b"napi-rs decmpfs compressible addon body pattern ";
  while raw.len() < 2 * 1024 * 1024 {
    raw.extend_from_slice(pattern);
  }
  raw.truncate(2 * 1024 * 1024);
  raw
}

/// A self-loading stub file: a minimal ELF64 carrying a `.DECMPFS` section whose
/// body is the producer's `[magic][content_hash][zstd payload]` (built via the
/// shared `section` ABI). Only the btrfs integration test (Linux) uses it, so the
/// ELF container is enough; the section body is identical to what the real
/// producer injects.
pub fn stub_with_section(raw: &[u8]) -> Vec<u8> {
  let payload = zstd::encode_all(raw, 3).unwrap();
  let body = build_section_payload(fnv1a64(raw), &payload);

  // ELF64 LE: [ehdr(64)][body][shstrtab][shdrs]. Three section headers
  // (SHT_NULL, .DECMPFS, .shstrtab); .shstrtab is index 2.
  let body_off = 64usize;
  let shstr = b"\0.DECMPFS\0.shstrtab\0";
  let shstr_off = body_off + body.len();
  let shoff = shstr_off + shstr.len();
  let shentsize = 64usize;
  let shnum = 3usize;
  let shstrndx = 2usize;
  let total = shoff + shnum * shentsize;
  let mut e = vec![0u8; total];
  e[0..4].copy_from_slice(b"\x7fELF");
  e[4] = 2; // 64-bit
  e[5] = 1; // little-endian
  e[6] = 1; // version
  e[40..48].copy_from_slice(&(shoff as u64).to_le_bytes()); // e_shoff
  e[58..60].copy_from_slice(&(shentsize as u16).to_le_bytes()); // e_shentsize
  e[60..62].copy_from_slice(&(shnum as u16).to_le_bytes()); // e_shnum
  e[62..64].copy_from_slice(&(shstrndx as u16).to_le_bytes()); // e_shstrndx
  e[body_off..body_off + body.len()].copy_from_slice(&body);
  e[shstr_off..shstr_off + shstr.len()].copy_from_slice(shstr);
  let sh1 = shoff + shentsize; // .DECMPFS (sh_name=1)
  e[sh1..sh1 + 4].copy_from_slice(&1u32.to_le_bytes());
  e[sh1 + 24..sh1 + 32].copy_from_slice(&(body_off as u64).to_le_bytes());
  e[sh1 + 32..sh1 + 40].copy_from_slice(&(body.len() as u64).to_le_bytes());
  let sh2 = shoff + 2 * shentsize; // .shstrtab (sh_name=10)
  e[sh2..sh2 + 4].copy_from_slice(&10u32.to_le_bytes());
  e[sh2 + 24..sh2 + 32].copy_from_slice(&(shstr_off as u64).to_le_bytes());
  e[sh2 + 32..sh2 + 40].copy_from_slice(&(shstr.len() as u64).to_le_bytes());
  e
}
