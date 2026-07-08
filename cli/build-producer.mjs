#!/usr/bin/env node
// Build the host build-time producer (crates/napi-compress) for the host triple
// and stage it at cli/bin/napi-compress-<hostTriple>[.exe]. This ships in
// @napi-rs/cli; the build (src/api/compress.ts) spawns it to compress a built
// `.node` and inject + ad-hoc-sign the signable SMOL/__DECMPFS section.
//
// Usage:
//   node cli/build-producer.mjs            # build for the host triple
//
// The producer is a HOST tool (it runs on the build machine, not the target), so
// there is one binary per build OS — not the per-target matrix the stubs need.
// The CLI e2e (cli/e2e/compress.spec.ts) builds it through this script; CI stages
// one per runner OS at release time.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(cliRoot, '..')
const binDir = join(cliRoot, 'bin')

const PROFILE = 'release'

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { env: process.env }).toString('utf8')
  const line = out.split('\n').find((l) => l.startsWith('host: '))
  const triple = line?.slice('host: '.length).trim()
  if (!triple) {
    throw new Error(
      'napi-compress build: cannot read the host triple.\n' +
        '  Where:  rustc -vV\n' +
        '  Saw:    no "host:" line\n' +
        '  Fix:    ensure a working rustup/rustc is on PATH.',
    )
  }
  return triple
}

const triple = hostTriple()
const exeSuffix = triple.includes('windows') ? '.exe' : ''
const cmd = process.env.CARGO || 'cargo'
execFileSync(cmd, ['build', '-p', 'napi-compress', '--profile', PROFILE], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
})

const built = join(repoRoot, 'target', PROFILE, `napi-compress${exeSuffix}`)
mkdirSync(binDir, { recursive: true })
const dest = join(binDir, `napi-compress-${triple}${exeSuffix}`)
copyFileSync(built, dest)
console.error(`producer: ${triple} -> ${dest}`)
