#!/usr/bin/env node
// Build the self-loading stub (crates/decmpfs-napi) for each supported target and
// stage it at cli/stubs/<triple>.node. These ship in @napi-rs/cli; the producer
// (src/api/compress.ts) appends the matching stub to each `--compress` addon.
//
// Usage:
//   node cli/build-stubs.mjs                 # all targets, stable (~350K stub)
//   node cli/build-stubs.mjs <triple>...     # only the given targets
//   BUILD_STD=1 node cli/build-stubs.mjs     # nightly: smallest stub (~135K)
//   ZIGBUILD=1 node cli/build-stubs.mjs      # cross-compile via cargo-zigbuild
//
// Run at release time to stage the shipped stubs; the CLI e2e (cli/e2e/cli.spec.ts)
// also builds the host stub through this script. For the smallest stub set
// BUILD_STD=1 on the pinned nightly (point CARGO/RUSTC at it, or let the run shell
// out to `rustup run <pin>`); a plain stable build works and only differs in size.
//
// The stub links libzstd (C, via zstd-sys), so cross-compiling a target needs a
// C cross-compiler. ZIGBUILD=1 uses cargo-zigbuild, which bundles one (zig cc),
// so the whole matrix builds without per-target gcc. Without it, cargo fails loud
// when a target's toolchain is missing rather than skipping it silently.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(cliRoot, '..')
const stubsDir = join(cliRoot, 'stubs')

// Targets whose filesystem exposes transparent compression (the stub's in-place
// self-rewrite activates there). Mirrors FS_COMPRESSION_TARGETS in
// src/utils/target.ts. On other targets the stub still works via the cache.
const DEFAULT_TARGETS = [
  'aarch64-apple-darwin',
  'aarch64-pc-windows-msvc',
  'aarch64-unknown-linux-gnu',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
]

const PROFILE = 'addon-min'

// BUILD_STD uses two nightly-only cargo features for the smallest stub:
// `-Z build-std` and `-Cpanic=immediate-abort`. Pin a known-good nightly so
// shipped stubs are reproducible. When BUILD_STD is set and the caller hasn't
// overridden CARGO, the build runs through `rustup run <pin>`.
//
// CHECK ON EACH RUST RELEASE: once build-std and -Cpanic=immediate-abort
// stabilize, drop this pin + the nightly requirement and build on stable.
//   build-std: https://doc.rust-lang.org/cargo/reference/unstable.html#build-std
const NIGHTLY_PIN = 'nightly-2026-03-28'

const buildStd = process.env.BUILD_STD === '1'
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_TARGETS

function cdylibName(triple) {
  if (triple.includes('apple-darwin')) {
    return 'libdecmpfs_napi.dylib'
  }
  if (triple.includes('windows')) {
    return 'decmpfs_napi.dll'
  }
  return 'libdecmpfs_napi.so'
}

function buildOne(triple) {
  const subcommand = process.env.ZIGBUILD === '1' ? 'zigbuild' : 'build'
  const args = [subcommand, '-p', 'decmpfs-napi', '--profile', PROFILE]
  const env = { ...process.env }
  if (buildStd) {
    // Rebuild std minimal for this target (nightly), and compile it with
    // panic=immediate-abort so std drops its unwind AND panic-message/formatting
    // machinery. The stub is panic-free, so this is pure size win (~435K -> ~135K).
    args.push('-Z', 'build-std=std,panic_abort')
    env.RUSTFLAGS =
      `${process.env.RUSTFLAGS ?? ''} -Zunstable-options -Cpanic=immediate-abort`.trim()
  }
  if (triple.includes('apple-darwin')) {
    // Reserve Mach-O header padding so the producer can write the __DECMPFS
    // LC_SEGMENT_64 load command into header slack — no section relocation, only a
    // __LINKEDIT shift. 0x1000 dwarfs one segment+section command (~152 bytes).
    // See crates/decmpfs/src/section.rs for the reader side.
    env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C link-arg=-Wl,-headerpad,0x1000`.trim()
  }
  args.push('--target', triple)
  // CARGO overrides the toolchain explicitly (matches build.ts). Otherwise, a
  // build-std build runs through the pinned nightly via `rustup run`; a plain
  // build uses whatever `cargo` is on PATH.
  let cmd = process.env.CARGO || 'cargo'
  let cmdArgs = args
  if (buildStd && !process.env.CARGO) {
    cmd = 'rustup'
    cmdArgs = ['run', NIGHTLY_PIN, 'cargo', ...args]
  }
  execFileSync(cmd, cmdArgs, { cwd: repoRoot, stdio: 'inherit', env })

  const built = join(repoRoot, 'target', triple, PROFILE, cdylibName(triple))
  const dest = join(stubsDir, `${triple}.node`)
  copyFileSync(built, dest)
  return dest
}

mkdirSync(stubsDir, { recursive: true })
for (const triple of targets) {
  const dest = buildOne(triple)
  console.error(`stub: ${triple} -> ${dest}`)
}
console.error(`\nbuilt ${targets.length} stub(s) into ${stubsDir}`)
