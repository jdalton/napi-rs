import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { renameAsync } from '../utils/index.js'

const execFileAsync = promisify(execFile)

// zstd only. The shipped stub decodes with libzstd (statically linked via
// zstd-sys) and the producer compresses with the same libzstd, so there is
// exactly one codec end to end — no second decoder to carry, no consumer-runtime
// fork. zstd is the right pick: within ~7% of brotli's size while decompressing
// ~2-3x faster, and the speed is what the consumer pays on first load.
//
// Level vs size vs build time, measured on lightningcss-darwin-arm64 (a stripped
// 8.52 MB Rust addon). Decompress is ~level-independent (~7-9 ms), so a higher
// level costs only *build* time, paid once.
//
//   zstd lvl   size       compress
//   --------   -------    --------
//      3       2.93 MB      24 ms
//      9       2.64 MB      93 ms
//  >> 16       2.54 MB     791 ms   (default: best size under ~1s compress)
//      19      2.31 MB    1711 ms
//  ++ 22       2.31 MB    1723 ms   (max: smallest blob, build time irrelevant)
const DEFAULT_LEVEL = 16
const LEVEL_RANGE = { max: 22, min: 1 }

export interface CompressedArtifact {
  // The compressed addon, written back over the original `.node` path — the
  // single self-loading file (the stub image carrying a SMOL/__DECMPFS section),
  // same filename.
  path: string
  rawSize: number
  // Size of the zstd payload inside the injected __DECMPFS section.
  compSize: number
  // Total on-disk size of the produced, ad-hoc-signed `.node`.
  totalSize: number
  contentHash: bigint
  level: number
}

export interface CompressOptions {
  // zstd level. Omit for the sensible sub-1s default (16); turn it up to 22 for
  // the smallest blob when build time does not matter. Clamped to 1..22.
  level?: number
  // Path to the prebuilt stub cdylib for THIS artifact's target, shipped in
  // `@napi-rs/cli`. The caller (build.ts) resolves it from the target triple.
  stubPath: string
  // Path to the host `napi-compress` producer binary, shipped in `@napi-rs/cli`.
  // It compresses the addon and injects + ad-hoc-signs the signable __DECMPFS
  // section. The caller (build.ts) resolves it from the host triple.
  napiCompressPath: string
}

// The producer's one-line JSON receipt (crates/napi-compress/src/main.rs).
interface ProducerReceipt {
  rawSize: number
  compSize: number
  totalSize: number
  contentHash: string
}

function clampLevel(level: number): number {
  if (Number.isNaN(level)) {
    return DEFAULT_LEVEL
  }
  return Math.max(LEVEL_RANGE.min, Math.min(LEVEL_RANGE.max, Math.trunc(level)))
}

// Compress a built `.node` in place into the single self-loading file: the stub
// image carrying a signable SMOL/__DECMPFS section (the zstd payload + its content
// hash), ad-hoc re-signed so it stays `codesign -v`-clean and notarizable. Same
// filename, no sidecars, no JS loader. Node `dlopen`s it and the stub reads its own
// section: on a compressing filesystem it rewrites the file in place into the raw
// FS-compressed addon (kernel decompress-on-read thereafter), else it decodes to an
// ephemeral content-addressed cache. See crates/napi-compress + crates/decmpfs-napi.
//
// The deterministic Rust producer owns the whole operation (compress + Mach-O
// surgery + sign); there is no JS fallback — a failure throws LOUD so the build
// never ships a half-compressed or unsigned `.node`.
export async function compressNodeArtifact(
  nodePath: string,
  options: CompressOptions,
): Promise<CompressedArtifact> {
  const level = clampLevel(options.level ?? DEFAULT_LEVEL)
  const outPath = `${nodePath}.compressed`
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(options.napiCompressPath, [
      options.stubPath,
      nodePath,
      outPath,
      '--level',
      String(level),
    ]))
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(
      'napi-rs --compress: the napi-compress producer failed.\n' +
        `  Where:    ${options.napiCompressPath}\n` +
        `  Saw:      ${detail}\n` +
        '  Fix:      reinstall @napi-rs/cli, or rebuild the producer with\n' +
        '            cli/build-producer.mjs for this host.',
    )
  }
  const receipt = JSON.parse(stdout) as ProducerReceipt
  // The producer wrote a fresh, signed file beside the addon; move it over the
  // original so the compressed `.node` keeps its name.
  await renameAsync(outPath, nodePath)
  return {
    compSize: receipt.compSize,
    contentHash: BigInt(`0x${receipt.contentHash}`),
    level,
    path: nodePath,
    rawSize: receipt.rawSize,
    totalSize: receipt.totalSize,
  }
}
