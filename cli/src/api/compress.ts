import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

import { readFileAsync, unlinkAsync, writeFileAsync } from '../utils/index.js'

// Load zlib via require (bare specifier — no `node:` scheme, resolves on every
// Node) so the optional zstd members are a runtime feature-detect rather than a
// static ESM binding that would throw on a runtime without them.
//
// Compression is async (off the main thread, build-time); decompression in the
// generated loader is sync because it runs inside `require()`.
const require = createRequire(import.meta.url)
const zlib = require('zlib') as typeof import('node:zlib')

// zstd is the default: it strikes the best balance of size and decompress speed
// (the cost paid on first load) — within ~7% of brotli's size while
// decompressing ~2-3x faster. brotli is the fallback for build/consumer Node
// without zstd, and is selectable for packages that want the smallest blob or
// must support older consumer runtimes.
//
// Measured on lightningcss-darwin-arm64, a stripped 8,516,384-byte Rust addon
// (default level / ceiling; see the level table below):
//   raw 8.52 MB -> zstd   2.54 MB default .. 2.31 MB max  decompress ~7-8 ms
//   raw 8.52 MB -> brotli 2.50 MB default .. 2.15 MB max  decompress ~17-20 ms
// Consumer Node floor: zstd >= 22.15 (every maintained release: 22 LTS, 24
// active); brotli >= 11.7 (covers EOL runtimes).
//
//   zstd*Sync   — Added in Node v23.8.0, backported to LTS v22.15.0:
//     https://github.com/nodejs/node/releases/tag/v23.8.0
//     https://github.com/nodejs/node/releases/tag/v22.15.0
//   brotli*Sync — Added in Node v11.7.0 (and v10.16.0):
//     https://nodejs.org/api/zlib.html#zlibbrotlicompresssyncbuffer-options
export type CompressAlgo = 'brotli' | 'zstd'

// Level vs size vs build time vs load cost, measured on lightningcss-darwin-arm64
// (a stripped Rust addon). The decompress column confirms it is ~level-independent
// (zstd ~7-9 ms, brotli ~18-22 ms), so a higher level only costs *build* time,
// paid once — never load time.
//
//   original payload (raw, uncompressed .node): 8.52 MB (8,516,384 bytes)
//   the `size` columns below are that payload after compression at each level.
//
//   zstd lvl   size      compress  decomp       brotli q   size      compress  decomp
//   --------   -------   --------  ------       --------   -------   --------  ------
//      3       2.93 MB     24 ms   7.5 ms          q4      2.86 MB     61 ms   18.4 ms
//      9       2.64 MB     93 ms   7.2 ms          q6      2.55 MB    112 ms   18.3 ms
//     12       2.62 MB    157 ms   7.3 ms          q7      2.51 MB    307 ms   18.1 ms
//  >> 16       2.54 MB    791 ms   7.6 ms          q8      2.50 MB    380 ms   18.1 ms
//     17       2.41 MB   1182 ms   7.8 ms       >> q9      2.50 MB    578 ms   17.8 ms
//     18       2.32 MB   1559 ms   8.7 ms          q10     2.22 MB   5752 ms   22.5 ms
//     19       2.31 MB   1711 ms   8.7 ms          q11     2.15 MB  12734 ms   20.3 ms
//  ++ 22       2.31 MB   1723 ms   8.5 ms          (q11 = max)
//
// Defaults (>>) are the best size with sub-1s compress — the sensible fast build.
// Ceilings (++ / q11) are reachable via the `level` option / `--compress-level`
// for the smallest possible blob when build time does not matter. Note zstd
// decompresses ~2.5x faster than brotli at every level — the load-time win.
const DEFAULT_LEVEL: Record<CompressAlgo, number> = { brotli: 9, zstd: 16 }
const LEVEL_RANGE: Record<CompressAlgo, { min: number; max: number }> = {
  brotli: { min: 0, max: 11 },
  zstd: { min: 1, max: 22 },
}

export interface CompressedArtifact {
  blobPath: string
  manifestPath: string
  rawSize: number
  compSize: number
  sha256: string
  algo: CompressAlgo
  level: number
}

// Accessed off the namespace so a missing zstd member on an older runtime is
// `undefined` rather than an import-time SyntaxError. The producer compresses
// async (`zstdCompress`); the loader decompresses sync (`zstdDecompressSync`).
function isZstdAvailable(): boolean {
  return (
    typeof zlib.zstdCompress === 'function' &&
    typeof zlib.zstdDecompressSync === 'function'
  )
}

// Resolve the requested codec against what this (build) runtime can produce,
// falling back to brotli when zstd is requested but unavailable.
export function resolveCompressAlgo(requested: CompressAlgo = 'zstd'): CompressAlgo {
  if (requested === 'zstd' && !isZstdAvailable()) {
    return 'brotli'
  }
  return requested
}

function clampLevel(algo: CompressAlgo, level: number): number {
  const { min, max } = LEVEL_RANGE[algo]
  if (Number.isNaN(level)) {
    return DEFAULT_LEVEL[algo]
  }
  return Math.max(min, Math.min(max, Math.trunc(level)))
}

// Async compression (build-time, off the main thread). See the level table above
// for the size/build-time tradeoff per level.
function compressBuffer(
  raw: Buffer,
  algo: CompressAlgo,
  level: number,
): Promise<Buffer> {
  if (algo === 'zstd') {
    return promisify(zlib.zstdCompress)(raw, {
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: level,
      },
    })
  }
  return promisify(zlib.brotliCompress)(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: level,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  })
}

// Compress a built `.node` into `<name>.node.{zst,br}` + a `<name>.node.json`
// sha256 manifest, then remove the raw `.node`. The generated self-extracting
// loader (see templates/js-binding.ts) consumes this pair: it reads the manifest,
// decompresses to a content-addressed cache on first load, and verifies the
// sha256 before dlopen. The actual codec used is recorded in the manifest, so
// the loader never has to guess.
export interface CompressOptions {
  algo?: CompressAlgo
  // Codec level. Omit for the sensible sub-1s-compress default (zstd 16 /
  // brotli 9); turn it up to the codec max (zstd 22 / brotli 11) for the
  // smallest blob. Clamped to the codec's valid range.
  level?: number
}

export async function compressNodeArtifact(
  nodePath: string,
  options: CompressOptions = {},
): Promise<CompressedArtifact> {
  const algo = resolveCompressAlgo(options.algo)
  const level = clampLevel(
    algo,
    options.level === undefined ? DEFAULT_LEVEL[algo] : options.level,
  )
  const raw = await readFileAsync(nodePath)
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const compressed = await compressBuffer(raw, algo, level)
  const ext = algo === 'zstd' ? '.zst' : '.br'
  const blobPath = `${nodePath}${ext}`
  const manifestPath = `${nodePath}.json`
  await writeFileAsync(blobPath, compressed)
  await writeFileAsync(
    manifestPath,
    JSON.stringify(
      {
        algo,
        level,
        sha256,
        rawSize: raw.length,
        compSize: compressed.length,
      },
      null,
      2,
    ),
  )
  await unlinkAsync(nodePath)
  return {
    blobPath,
    manifestPath,
    rawSize: raw.length,
    compSize: compressed.length,
    sha256,
    algo,
    level,
  }
}
