import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, zstdDecompressSync } from 'node:zlib'

import ava from 'ava'

import {
  compressNodeArtifact,
  resolveCompressAlgo,
} from '../compress.js'

const test = ava
const require = createRequire(import.meta.url)

test('resolveCompressAlgo defaults to zstd, falling back to brotli when zstd is unavailable', (t) => {
  const zstdAvailable = typeof require('zlib').zstdCompress === 'function'
  t.is(resolveCompressAlgo(), zstdAvailable ? 'zstd' : 'brotli')
  t.is(resolveCompressAlgo('brotli'), 'brotli')
  t.is(resolveCompressAlgo('zstd'), zstdAvailable ? 'zstd' : 'brotli')
})

test('compressNodeArtifact (brotli) emits a .node.br + sha256 manifest and removes the raw .node', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'napi-compress-'))
  const nodePath = join(dir, 'addon.darwin-arm64.node')
  // Random bytes stand in for a real addon; the codec/manifest path is identical.
  const raw = randomBytes(64 * 1024)
  await writeFile(nodePath, raw)

  const result = await compressNodeArtifact(nodePath, { algo: 'brotli' })

  // Raw .node is gone; the compressed pair is in its place.
  t.false(existsSync(nodePath), 'raw .node should be removed')
  t.true(existsSync(result.blobPath), '.node.br should exist')
  t.true(existsSync(result.manifestPath), '.node.json manifest should exist')
  t.is(result.blobPath, `${nodePath}.br`)
  t.is(result.manifestPath, `${nodePath}.json`)
  t.is(result.algo, 'brotli')

  // Manifest carries the sha256 of the *decompressed* binary (the dlopen target).
  const expectedSha = createHash('sha256').update(raw).digest('hex')
  t.is(result.sha256, expectedSha)
  t.is(result.rawSize, raw.length)

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
  t.is(manifest.algo, 'brotli')
  t.is(manifest.sha256, expectedSha)
  t.is(manifest.rawSize, raw.length)
  t.is(manifest.compSize, result.compSize)

  // Round-trip: the blob decompresses back to the exact bytes the manifest pins.
  const restored = brotliDecompressSync(await readFile(result.blobPath))
  t.true(Buffer.from(restored).equals(raw), 'decompressed bytes must match the original')
  t.is(createHash('sha256').update(restored).digest('hex'), expectedSha)
})

test('compressNodeArtifact (zstd) round-trips and writes a complete manifest', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'napi-compress-zstd-'))
  const nodePath = join(dir, 'addon.darwin-arm64.node')
  const raw = randomBytes(64 * 1024)
  await writeFile(nodePath, raw)

  const result = await compressNodeArtifact(nodePath, { algo: 'zstd' })
  const expectedSha = createHash('sha256').update(raw).digest('hex')

  t.false(existsSync(nodePath))
  t.is(result.blobPath, `${nodePath}.zst`)
  t.is(result.algo, 'zstd')
  // zstd default level is 16 (the sub-1s knee).
  t.is(result.level, 16)
  t.is(result.sha256, expectedSha)
  t.is(result.rawSize, raw.length)

  // Manifest carries every field the loader / tooling relies on.
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
  t.deepEqual(manifest, {
    algo: 'zstd',
    level: 16,
    sha256: expectedSha,
    rawSize: raw.length,
    compSize: result.compSize,
  })

  // The blob decompresses back to the exact bytes the manifest pins.
  const restored = zstdDecompressSync(await readFile(result.blobPath))
  t.true(Buffer.from(restored).equals(raw))
  t.is(createHash('sha256').update(restored).digest('hex'), expectedSha)
})

test('compressNodeArtifact uses the sub-1s default level and honors an explicit override', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'napi-compress-level-'))

  // Default brotli level is q9 (the sub-1s knee).
  const def = join(dir, 'a.darwin-arm64.node')
  await writeFile(def, randomBytes(32 * 1024))
  const defResult = await compressNodeArtifact(def, { algo: 'brotli' })
  t.is(defResult.level, 9)

  // Explicit level is recorded in the manifest...
  const over = join(dir, 'b.darwin-arm64.node')
  await writeFile(over, randomBytes(32 * 1024))
  const overResult = await compressNodeArtifact(over, { algo: 'brotli', level: 5 })
  t.is(overResult.level, 5)
  const manifest = JSON.parse(await readFile(overResult.manifestPath, 'utf8'))
  t.is(manifest.level, 5)

  // ...out-of-range values are clamped to the codec ceiling (brotli max 11)...
  const hi = join(dir, 'c.darwin-arm64.node')
  await writeFile(hi, randomBytes(32 * 1024))
  const hiResult = await compressNodeArtifact(hi, { algo: 'brotli', level: 99 })
  t.is(hiResult.level, 11)

  // ...and to the floor (zstd min 1)...
  const lo = join(dir, 'd.darwin-arm64.node')
  await writeFile(lo, randomBytes(32 * 1024))
  const loResult = await compressNodeArtifact(lo, { algo: 'zstd', level: 0 })
  t.is(loResult.level, 1)

  // ...and a non-numeric level falls back to the codec default (zstd 16).
  const nan = join(dir, 'e.darwin-arm64.node')
  await writeFile(nan, randomBytes(32 * 1024))
  const nanResult = await compressNodeArtifact(nan, {
    algo: 'zstd',
    level: Number.NaN,
  })
  t.is(nanResult.level, 16)
})
