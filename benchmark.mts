// napi --compress benchmark — reproduces the size / decompress / throughput numbers
// from https://github.com/orgs/napi-rs/discussions/3350
//
// Measured on Node 26.3.1 (darwin-arm64). Run with:
//   node benchmark.mts [path/to/addon.node]
// Node >= 23.6 runs .mts directly (native type stripping); on 22.x use
//   node --experimental-strip-types benchmark.mts
// zstd in node:zlib needs Node >= 22.15; brotli >= 11.7.
//
// With no argument it resolves the installed lightningcss native; pass any
// `.node` path to benchmark a different addon (e.g. the rolldown binding).

import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const out: string[] = []
const MB = (n: number): string => `${(n / 1e6).toFixed(2)} MB`

function bestMs(fn: () => void, runs = 10): number {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint()
    fn()
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    if (ms < best) best = ms
  }
  return best
}

function dirSize(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += dirSize(p)
    } else {
      try {
        total += statSync(p).size
      } catch {
        // file vanished between readdir and stat; ignore
      }
    }
  }
  return total
}

function resolveAddon(): string {
  if (process.argv[2]) return process.argv[2]
  const tuple = `${process.platform}-${process.arch}`
  try {
    return require.resolve(`lightningcss-${tuple}/lightningcss.${tuple}.node`)
  } catch {
    throw new Error(
      'Pass a path to a .node addon, e.g.\n' +
        '  node benchmark.mts node_modules/lightningcss-darwin-arm64/lightningcss.darwin-arm64.node',
    )
  }
}

const addonPath = resolveAddon()
const raw = readFileSync(addonPath)
out.push(`node ${process.version} · ${process.platform}-${process.arch}`)
out.push(`addon: ${addonPath}`)

// Node's compile cache (vite enables it via module.enableCompileCache(), no
// dir + no CI gate, so it lands here). Report its size and clear it so each
// benchmark run starts from a cold, comparable state.
const compileCacheDir =
  process.env.NODE_COMPILE_CACHE || join(tmpdir(), 'node-compile-cache')
if (existsSync(compileCacheDir)) {
  out.push(`node compile cache: ${MB(dirSize(compileCacheDir))} at ${compileCacheDir} (clearing)`)
  rmSync(compileCacheDir, { recursive: true, force: true })
} else {
  out.push(`node compile cache: empty at ${compileCacheDir}`)
}

out.push(`raw size: ${MB(raw.length)}`)

// Raw .node load (dlopen). This is the baseline both raw and cached loads pay.
// It's OS-page-cache-dominated: ~1 ms warm, up to ~13 ms on a cold first read,
// ~0 ms to re-require in-process. (The file is already warm here from the read
// above, so this reports the warm case.)
try {
  const t = process.hrtime.bigint()
  require(addonPath)
  out.push(`raw require (warm, OS-cache-dependent): ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2)} ms\n`)
} catch {
  out.push('')
}

const codecs = [
  {
    name: 'brotli q9',
    compress: () =>
      brotliCompressSync(raw, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 9,
          [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      }),
    decompress: brotliDecompressSync,
  },
  {
    name: 'zstd 16',
    compress: () =>
      zstdCompressSync(raw, {
        params: { [constants.ZSTD_c_compressionLevel]: 16 },
      }),
    decompress: zstdDecompressSync,
  },
]

for (const { name, compress, decompress } of codecs) {
  const blob = compress()
  const decompressMs = bestMs(() => decompress(blob))
  // The one-time first-load work the loader adds over a raw require: decompress,
  // sha256-verify, write the cache file. (The dlopen both paths pay is excluded;
  // a bare require()'s wall time is dominated by OS file-cache state, ~1-12 ms.)
  const oneTimeMs = bestMs(() => {
    const decompressed = decompress(blob)
    createHash('sha256').update(decompressed).digest('hex')
    const tmp = join(tmpdir(), `bench-${process.pid}-${name.replace(/\W/g, '')}.node`)
    writeFileSync(tmp, decompressed)
    unlinkSync(tmp)
  })
  out.push(
    `${name.padEnd(10)} ${MB(blob.length)}  ${(raw.length / blob.length).toFixed(2)}x  ` +
      `decompress ${decompressMs.toFixed(1)}ms  ` +
      `one-time(decompress+verify+write) ${oneTimeMs.toFixed(0)}ms`,
  )
}

// Per-cache-hit overhead the loader adds over a bare require: existsSync +
// read & parse the small manifest. The dlopen itself is identical to a raw
// load, so this (not zero, but tiny) is the steady-state cost of --compress.
{
  const manifest = JSON.stringify({
    algo: 'zstd',
    sha256: createHash('sha256').update(raw).digest('hex'),
    rawSize: raw.length,
  })
  const manifestPath = join(tmpdir(), `bench-${process.pid}.node.json`)
  writeFileSync(manifestPath, manifest)
  const overheadMs = bestMs(() => {
    existsSync(manifestPath)
    JSON.parse(readFileSync(manifestPath, 'utf8'))
    existsSync(manifestPath)
  }, 200)
  unlinkSync(manifestPath)
  out.push(
    `\ncache-hit overhead (existsSync + read+parse manifest, vs a raw require): ${overheadMs.toFixed(3)} ms`,
  )
}

// lightningcss transform() throughput, if this is the lightningcss addon.
try {
  const lightningcss = require('lightningcss') as {
    transform: (opts: unknown) => unknown
  }
  let css = ''
  for (let i = 0; i < 4000; i++) {
    css +=
      `.s${i}{color:#fff;background:rgba(0,0,0,.5);margin:calc(10px + 2vw);` +
      `transform:translateX(${i}px) rotate(45deg)} ` +
      `@media(min-width:${i}px){.s${i}{font-size:1.25rem}}`
  }
  const code = Buffer.from(css)
  const transformOptions = () => ({
    filename: 'in.css',
    code,
    minify: true,
    targets: { chrome: 80 << 16 },
  })
  for (let i = 0; i < 8; i++) lightningcss.transform(transformOptions()) // warm up
  const perOp =
    bestMs(() => {
      for (let i = 0; i < 80; i++) lightningcss.transform(transformOptions())
    }, 3) / 80
  out.push(
    `\nlightningcss transform() (minify ${(css.length / 1024).toFixed(0)} KB CSS): ` +
      `${perOp.toFixed(2)} ms/op  ->  ${(1000 / perOp).toFixed(0)} ops/sec`,
  )
} catch {
  // not lightningcss, or not installed — skip the throughput section
}

console.log(out.join('\n'))
