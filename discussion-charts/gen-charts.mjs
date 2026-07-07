// Regenerate the napi --compress discussion charts (#3350) from current numbers.
// The prior SVG sources were lost; this is the reproducible replacement.
// Source data: napi-rs/.claude/reports/stub-load-benchmark.md (current model).
//   node gen-charts.mjs   # writes compress-v16.svg + tradeoff-v16.svg here
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// GitHub-dark palette. green = win, gray = raw/neutral, orange = cost (never green
// for a cost). muted = labels, ink = headline text, code = inline code tokens.
const C = {
  bg: '#0d1117',
  border: '#30363d',
  ink: '#e6edf3',
  muted: '#8b949e',
  faint: '#6e7681',
  grid: '#21262d',
  raw: '#484f58',
  green: '#3fb950',
  orange: '#d29922',
  code: '#79c0ff',
}
const MONO = "ui-monospace, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace"
const SANS = "-apple-system, 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif"

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function text(x, y, s, o = {}) {
  const {
    size = 12,
    fill = C.muted,
    weight = 'normal',
    font = SANS,
    anchor = 'start',
  } = o
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`
}

// A prose line that can mix normal text with inline-code tokens (mono + blue).
function rich(x, y, parts, size, fill) {
  const spans = parts
    .map((p) =>
      p.code
        ? `<tspan font-family="${MONO}" fill="${C.code}">${esc(p.t)}</tspan>`
        : `<tspan font-family="${SANS}" fill="${fill}">${esc(p.t)}</tspan>`,
    )
    .join('')
  return `<text x="${x}" y="${y}" font-size="${size}" xml:space="preserve">${spans}</text>`
}

function rect(x, y, w, h, fill, rx = 3, op = 1) {
  return `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${h}" rx="${rx}" fill="${fill}" fill-opacity="${op}"/>`
}

function rule(x1, x2, y) {
  return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${C.grid}"/>`
}

function chip(x, y, fill, label) {
  return rect(x, y - 10, 11, 11, fill, 2) + text(x + 17, y, label, { size: 11 })
}

// 🤏 pinching-hand (Noto Emoji, Apache-2.0) read from the committed pinch-noto.svg
// and embedded as a nested SVG so it renders in color through rsvg-convert (the
// emoji font path renders monochrome). Apache-2.0 needs no visible attribution.
const PINCH = readFileSync(join(here, 'pinch-noto.svg'), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')

function pinch(x, y, size) {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 128 128">${PINCH}</svg>`
}

function frame(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="${C.bg}" stroke="${C.border}"/>
${inner}
</svg>`
}

// ---- headline: compress-v16 (also covers first load) ------------------------
function headline() {
  const W = 640
  const H = 606
  const PAD = 30
  const out = []
  out.push(
    text(PAD, 50, 'napi build --compress', {
      size: 27,
      fill: C.green,
      weight: 'bold',
      font: MONO,
    }),
  )
  out.push(
    text(PAD, 73, 'ship native addons smaller, at the same runtime speed', {
      size: 13,
      fill: C.muted,
    }),
  )
  out.push(
    text(PAD, 91, 'vite 8.1.0  ·  darwin-arm64  ·  zstd-16', {
      size: 11.5,
      fill: C.faint,
    }),
  )

  // three green headline stats, spaced for even gaps across the row
  const stats = [
    { x: PAD, big: '−68%', sub: 'size on disk' },
    { x: 172, big: '3.4× smaller', sub: 'up to, per addon', emoji: true },
    { x: 470, big: 'same', sub: 'runtime speed & memory' },
  ]
  for (const s of stats) {
    out.push(
      text(s.x, 138, s.big, {
        size: 26,
        fill: C.green,
        weight: 'bold',
        font: MONO,
      }),
    )
    out.push(text(s.x, 158, s.sub, { size: 11, fill: C.muted }))
    if (s.emoji) {
      out.push(pinch(s.x + s.big.length * 15.6 + 6, 116, 24))
    }
  }

  out.push(chip(PAD, 187, C.raw, 'raw *.node'))
  out.push(chip(PAD + 100, 187, C.green, 'decmpfs *.node'))

  // install size
  out.push(
    text(PAD, 218, 'Install size', { size: 13.5, fill: C.ink, weight: 'bold' }),
  )
  out.push(
    text(PAD + 86, 218, '— MB on disk, lower is better', {
      size: 11.5,
      fill: C.muted,
    }),
  )
  const bx = 150
  const bw = 330
  const sc = bw / 26
  let grid = ''
  for (let t = 0; t <= 25; t += 5) {
    const gx = bx + t * sc
    grid += `<line x1="${gx}" y1="232" x2="${gx}" y2="312" stroke="${C.grid}"/>`
    grid += text(gx, 326, String(t), {
      size: 9.5,
      fill: C.faint,
      anchor: 'middle',
    })
  }
  out.push(grid)
  out.push(text(bx + bw + 8, 326, 'MB', { size: 9.5, fill: C.faint }))
  const sizes = [
    { name: 'lightningcss', raw: 8.52, comp: 2.54 },
    { name: 'rolldown', raw: 17.22, comp: 5.61 },
    { name: 'vite (both)', raw: 25.74, comp: 8.15 },
  ]
  let y = 240
  for (const d of sizes) {
    out.push(text(PAD, y + 10, d.name, { size: 12, fill: C.ink }))
    out.push(rect(bx, y, d.raw * sc, 12, C.raw))
    out.push(rect(bx, y, d.comp * sc, 12, C.green))
    out.push(
      text(bx + d.raw * sc + 8, y + 10, `${d.raw} → ${d.comp}`, {
        size: 11,
        fill: C.muted,
      }),
    )
    y += 24
  }

  // load time — steady state bars (the headline "same speed").
  out.push(
    text(PAD, 356, 'Load time', { size: 13.5, fill: C.ink, weight: 'bold' }),
  )

  function miniRow(yRow, label, segs, scl, vb, valText, o = {}) {
    const { h = 14, vf = C.muted } = o
    const tb = yRow + Math.round(h * 0.8) + 1
    out.push(text(PAD, tb, label, { size: 11.5, fill: C.ink }))
    let cx = vb
    for (const seg of segs) {
      out.push(rect(cx, yRow, seg.ms * scl, h, seg.c))
      cx += seg.ms * scl
    }
    out.push(text(cx + 8, tb, valText, { size: 10.5, fill: vf }))
  }

  out.push(
    text(PAD, 374, 'steady state · every load after the first', {
      size: 11,
      fill: C.muted,
    }),
  )
  const ssc = 110 / 2
  miniRow(382, 'raw *.node', [{ ms: 1.48, c: C.raw }], ssc, 190, '1.48 ms · baseline', { h: 9 })
  miniRow(
    398,
    'decmpfs',
    [{ ms: 1.48, c: C.green }],
    ssc,
    190,
    '1.48 ms · native, overwritten stub',
    { h: 9 },
  )
  miniRow(
    414,
    'fallback tmpdir',
    [{ ms: 1.8, c: C.green }],
    ssc,
    190,
    '1.80 ms +0.3 ms',
    { h: 9 },
  )
  out.push(
    text(
      PAD,
      436,
      '+0.3 ms = per-load stub overhead — a footer read, one stat, the stub’s own dlopen; not decode + cache write (first-load only).',
      { size: 9, fill: C.faint },
    ),
  )

  // bottom rule + plain-language explainer of where it loads native vs. cached.
  out.push(rule(PAD, W - PAD, 450))
  out.push(
    text(PAD, 470, 'How it loads — and where', {
      size: 12.5,
      fill: C.ink,
      weight: 'bold',
    }),
  )
  const fl = [
    [
      { t: 'With the ' },
      { t: '--compress', code: 1 },
      { t: ' flag, each generated ' },
      { t: '*.node', code: 1 },
      { t: ' is a small self-loading file. On a filesystem with' },
    ],
    [
      {
        t: 'built-in compression it rewrites itself compressed on first load and then loads at native speed, never unpacked',
      },
    ],
    [
      {
        t: 'again. Those are APFS (the default on every modern Mac) and NTFS (the default on every Windows PC), so all macOS',
      },
    ],
    [
      {
        t: 'and Windows machines qualify — including GitHub Actions runners and most cloud Windows/macOS instances. On Linux',
      },
    ],
    [
      {
        t: 'it is btrfs (default on Fedora and openSUSE); but most Linux servers and CI — GitHub Actions Ubuntu, the usual',
      },
    ],
    [
      {
        t: 'AWS / Azure / GCP images — run ext4 or xfs, which do not compress, so there it falls back to an ephemeral system',
      },
    ],
    [
      {
        t: 'cache (the OS temp dir, cleared on reboot; plus the +0.3 ms above). On a compressing filesystem the first load is the same',
      },
    ],
    [
      { t: 'or faster than the raw ' },
      { t: '.node', code: 1 },
      { t: ' — the kernel reads fewer bytes — so no load penalty; only the ext4/xfs fallback decodes once.' },
    ],
  ]
  let fy = 488
  for (const line of fl) {
    out.push(rich(PAD, fy, line, 9.5, C.muted))
    fy += 14
  }
  return frame(W, H, out.join('\n'))
}

// ---- why not shrink the binary: tradeoff-v16 -------------------------------
function tradeoff() {
  const W = 760
  const H = 600
  const PAD = 36
  const LBL = 'Rust build opt-level=z'
  const out = []
  out.push(
    text(PAD, 50, 'Why not just shrink the Rust binary?', {
      size: 22,
      fill: C.ink,
      weight: 'bold',
    }),
  )
  out.push(
    text(
      PAD,
      72,
      'lightningcss 1.32.0  ·  darwin-arm64  ·  benchmark: transform() minifying a 1.16 MB stylesheet, best-of-3',
      { size: 11.5, fill: C.muted },
    ),
  )
  out.push(chip(PAD, 104, C.raw, 'raw (ships today)'))
  out.push(chip(PAD + 150, 104, C.orange, LBL))
  out.push(chip(PAD + 340, 104, C.green, '--compress'))

  const bx = 205
  const bw = 480
  function section(title, unit, yTop, max, ticks, rows) {
    out.push(text(PAD, yTop, title, { size: 14, fill: C.ink, weight: 'bold' }))
    out.push(
      text(PAD + title.length * 8.4, yTop, `— ${unit}`, {
        size: 11.5,
        fill: C.muted,
      }),
    )
    const sc = bw / max
    let g = ''
    for (const t of ticks) {
      const gx = bx + t * sc
      g += `<line x1="${gx}" y1="${yTop + 14}" x2="${gx}" y2="${yTop + 116}" stroke="${C.grid}"/>`
      g += text(gx, yTop + 132, String(t), {
        size: 9.5,
        fill: C.faint,
        anchor: 'middle',
      })
    }
    out.push(g)
    out.push(
      text(bx + max * sc + 6, yTop + 132, unit.split(',')[0], {
        size: 9.5,
        fill: C.faint,
      }),
    )
    let yy = yTop + 22
    for (const r of rows) {
      out.push(text(PAD, yy + 15, r.label, { size: 11.5, fill: C.ink }))
      out.push(rect(bx, yy, r.v * sc, 22, r.c))
      out.push(
        text(bx + r.v * sc + 8, yy + 15, r.note, { size: 11, fill: C.muted }),
      )
      yy += 32
    }
  }

  section('Binary size', 'MB, lower is better', 150, 9, [0, 2, 4, 6, 8], [
    { label: 'raw', v: 8.52, c: C.raw, note: '8.52' },
    { label: LBL, v: 3.44, c: C.orange, note: '3.44' },
    { label: '--compress', v: 2.54, c: C.green, note: '2.54' },
  ])
  section(
    'Minify throughput',
    'ops/sec, higher is better',
    330,
    65,
    [0, 20, 40, 60],
    [
      { label: 'raw', v: 60, c: C.raw, note: '~60' },
      { label: LBL, v: 19, c: C.orange, note: '~19 · ~3× slower' },
      { label: '--compress', v: 60, c: C.green, note: '~60 · same as raw' },
    ],
  )

  out.push(rule(PAD, W - PAD, 482))
  out.push(
    text(PAD, 502, 'The takeaway', {
      size: 12.5,
      fill: C.ink,
      weight: 'bold',
    }),
  )
  const ft = [
    [
      {
        t: 'The native file is already optimized about as much as the usual build flags allow, so there isn’t much size',
      },
    ],
    [
      { t: 'left to remove at compile time. You can push harder with the ' },
      { t: 'opt-level=z', code: 1 },
      { t: ' build setting — it makes the' },
    ],
    [
      {
        t: 'file smaller, but it also makes the library run noticeably slower (about 3× here). ',
      },
      { t: '--compress', code: 1 },
      { t: ' gives you a' },
    ],
    [
      {
        t: 'smaller file and the exact same runtime speed, because the code that runs is byte-for-byte identical — just',
      },
    ],
    [
      {
        t: 'stored compressed and unpacked once. (ops/sec depends on the machine, but the ratio between them holds.)',
      },
    ],
  ]
  // Note font is bumped to ~11 px so that, after this wider chart (760) is scaled
  // to the same display width as compress-v16 (640), it reads at the same size.
  let fy = 522
  for (const line of ft) {
    out.push(rich(PAD, fy, line, 11, C.muted))
    fy += 16
  }
  return frame(W, H, out.join('\n'))
}

writeFileSync(join(here, 'compress-v16.svg'), headline())
writeFileSync(join(here, 'tradeoff-v16.svg'), tradeoff())
console.log('wrote compress-v16.svg + tradeoff-v16.svg')
