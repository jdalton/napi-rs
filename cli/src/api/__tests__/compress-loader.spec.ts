import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, zstdCompressSync } from 'node:zlib'

import ava from 'ava'

import { loadCompressedHelper } from '../templates/js-binding.js'

const test = ava
const realRequire = createRequire(import.meta.url)

// Build the inlined loader into a callable. The addon `require(...)` (any `.node`
// path) is intercepted to return a sentinel instead of dlopen-ing real bytes, so
// the decompress / verify / cache logic can be exercised in isolation. Builtin
// requires (fs, path, zlib, crypto, os) pass through.
function buildLoader(requireImpl: (id: string) => unknown) {
  return new Function(
    'require',
    `${loadCompressedHelper}\nreturn __napiLoadCompressed`,
  )(requireImpl) as (dir: string, base: string) => { __loadedFrom: string }
}

// Default shim: builtins pass through; any `.node` require returns a sentinel
// instead of dlopen-ing real bytes.
function defaultShim(id: string) {
  if (id.endsWith('.node')) {
    return { __loadedFrom: id }
  }
  return realRequire(id)
}

function makeLoader() {
  return buildLoader(defaultShim)
}

const BASE = 'addon.darwin-arm64'

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'napi-loader-'))
  process.env.NAPI_RS_NATIVE_CACHE = join(dir, 'cache')
  return dir
}

function writeArtifact(
  dir: string,
  raw: Buffer,
  algo: 'brotli' | 'zstd',
  sha = createHash('sha256').update(raw).digest('hex'),
) {
  const ext = algo === 'zstd' ? '.zst' : '.br'
  const blob = algo === 'zstd' ? zstdCompressSync(raw) : brotliCompressSync(raw)
  writeFileSync(join(dir, `${BASE}.node${ext}`), blob)
  writeFileSync(
    join(dir, `${BASE}.node.json`),
    JSON.stringify({ algo, sha256: sha, rawSize: raw.length, compSize: blob.length }),
  )
}

test('brotli: decompresses, verifies sha256, caches, and loads', (t) => {
  const dir = fixtureDir()
  const raw = randomBytes(48 * 1024)
  writeArtifact(dir, raw, 'brotli')

  const result = makeLoader()(dir, BASE)

  // Loaded from the cache (content-addressed by sha), not the package dir.
  t.true(result.__loadedFrom.includes('cache'))
  t.true(result.__loadedFrom.endsWith('.node'))
  // The cached file is the exact decompressed binary.
  t.true(readFileSync(result.__loadedFrom).equals(raw))
})

test('zstd: decompresses via the manifest codec and caches', (t) => {
  const dir = fixtureDir()
  const raw = randomBytes(48 * 1024)
  writeArtifact(dir, raw, 'zstd')

  const result = makeLoader()(dir, BASE)
  t.true(readFileSync(result.__loadedFrom).equals(raw))
})

test('integrity: a sha256 mismatch throws before loading', (t) => {
  const dir = fixtureDir()
  const raw = randomBytes(48 * 1024)
  // Manifest claims a different hash than the blob decompresses to.
  writeArtifact(dir, raw, 'brotli', 'deadbeef'.repeat(8))

  const err = t.throws(() => makeLoader()(dir, BASE))
  t.regex(err!.message, /integrity check failed/)
})

test('a raw .node next to the blob wins (dev / opt-out)', (t) => {
  const dir = fixtureDir()
  const raw = randomBytes(48 * 1024)
  writeArtifact(dir, raw, 'brotli')
  // A raw .node short-circuits decompression entirely.
  const rawPath = join(dir, `${BASE}.node`)
  writeFileSync(rawPath, raw)

  const result = makeLoader()(dir, BASE)
  t.is(result.__loadedFrom, rawPath)
})

test('the cache is reused on a second load (content-addressed)', (t) => {
  const dir = fixtureDir()
  const raw = randomBytes(48 * 1024)
  writeArtifact(dir, raw, 'brotli')

  const first = makeLoader()(dir, BASE)
  t.true(existsSync(first.__loadedFrom))
  // Second load resolves to the same cached path.
  const second = makeLoader()(dir, BASE)
  t.is(second.__loadedFrom, first.__loadedFrom)
})

test('a zstd artifact on a runtime without zstd throws a clear upgrade error', (t) => {
  const dir = fixtureDir()
  const raw = randomBytes(48 * 1024)
  writeArtifact(dir, raw, 'zstd')

  // Simulate Node < 22.15: zlib has no zstdDecompressSync.
  const zlibNoZstd = { ...realRequire('zlib'), zstdDecompressSync: undefined }
  const loader = buildLoader((id) =>
    id === 'zlib'
      ? zlibNoZstd
      : id.endsWith('.node')
        ? { __loadedFrom: id }
        : realRequire(id),
  )

  const err = t.throws(() => loader(dir, BASE))
  t.regex(err!.message, /zstd/)
  t.regex(err!.message, /22\.15/)
})

test('a missing manifest throws a helpful, actionable error', (t) => {
  const dir = fixtureDir()
  // A blob with no `.node.json` next to it.
  writeFileSync(join(dir, `${BASE}.node.br`), brotliCompressSync(randomBytes(1024)))

  const err = t.throws(() => makeLoader()(dir, BASE))
  t.regex(err!.message, /cannot read the compression manifest/)
  t.regex(err!.message, /\.node\.json/) // names the path
  t.regex(err!.message, /reinstall/) // names the fix
})

test('a malformed manifest throws a helpful error', (t) => {
  const dir = fixtureDir()
  writeFileSync(join(dir, `${BASE}.node.br`), brotliCompressSync(randomBytes(1024)))
  writeFileSync(join(dir, `${BASE}.node.json`), 'not json{')

  const err = t.throws(() => makeLoader()(dir, BASE))
  t.regex(err!.message, /cannot read the compression manifest/)
})

test('a manifest without sha256 throws a helpful error', (t) => {
  const dir = fixtureDir()
  writeFileSync(join(dir, `${BASE}.node.br`), brotliCompressSync(randomBytes(1024)))
  writeFileSync(join(dir, `${BASE}.node.json`), JSON.stringify({ algo: 'brotli' }))

  const err = t.throws(() => makeLoader()(dir, BASE))
  t.regex(err!.message, /no sha256 field/)
  t.regex(err!.message, /@napi-rs\/cli/) // names the fix
})

test('a missing blob throws a helpful error naming the path', (t) => {
  const dir = fixtureDir()
  const raw = randomBytes(1024)
  // Manifest present, blob absent.
  writeFileSync(
    join(dir, `${BASE}.node.json`),
    JSON.stringify({ algo: 'brotli', sha256: createHash('sha256').update(raw).digest('hex') }),
  )

  const err = t.throws(() => makeLoader()(dir, BASE))
  t.regex(err!.message, /cannot read the compressed binary/)
  t.regex(err!.message, /\.node\.br/)
})
