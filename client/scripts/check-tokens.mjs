/**
 * check-tokens.mjs — the visual contract's drift guard (S4 §1.2).
 *
 * Why a script and not a paragraph in the design doc: state colour now has two
 * legitimate homes (`style.css :root` for the DOM, `lib/palette.js` for WebGL,
 * because a canvas cannot read a CSS variable). Two homes for one fact is
 * exactly the shape H9 was about, and it took S3b one real-machine pass to find
 * a unit printed two ways. So the pairing is checked, not remembered.
 *
 * Run: node client/scripts/check-tokens.mjs   (exit 1 on any drift)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const CSS = readFileSync(join(SRC, 'style.css'), 'utf8')
const PAL = readFileSync(join(SRC, 'lib', 'palette.js'), 'utf8')

let pass = 0
const failures = []
const ok = (name) => { pass++; console.log(`PASS  ${name}`) }
const bad = (name, why) => { failures.push(`${name} — ${why}`); console.log(`FAIL  ${name}\n      ${why}`) }

/** The `:root { ... }` block, as token -> '#rrggbb'. */
function cssTokens() {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(CSS)
  if (!block) return null
  const out = {}
  for (const [, name, value] of block[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[name] = value.toLowerCase()
  }
  return out
}

/** A named export object in palette.js, as key -> '#rrggbb' (nested one level). */
function paletteGroup(name) {
  const start = new RegExp(`export const ${name} = \\{`).exec(PAL)
  if (!start) return null
  const body = PAL.slice(start.index + start[0].length)
  const end = body.indexOf('\n}')
  const out = {}
  for (const [, key, value] of body.slice(0, end).matchAll(/(\w+)\s*:\s*'(#[0-9a-fA-F]{6})'/g)) {
    out[key] = value.toLowerCase()
  }
  return out
}

const css = cssTokens()
if (!css) {
  bad('css :root parseable', 'no `:root { --token: #rrggbb; }` block found in style.css')
} else {
  const STATE_PAIRS = [
    ['STATE', 'OK', 'green', '正常：四态之一'],
    ['STATE', 'WARN', 'orange', '警告：四态之一'],
    ['STATE', 'CRIT', 'red', '严重：四态之一'],
    ['INK', 'ok', 'ok-ink', '正常的文字档'],
    ['INK', 'warn', 'warn-ink', '警告的文字档'],
    ['INK', 'crit', 'crit-ink', '严重的文字档'],
    ['GROUND', 'bg', 'bg', '场景底色 = 页面底色'],
  ]
  for (const [group, key, token, what] of STATE_PAIRS) {
    const pal = paletteGroup(group)
    const a = pal?.[key]
    const b = css[token]
    const name = `palette.${group}.${key} === --${token} (${what})`
    if (!pal) bad(name, `palette.js has no export const ${group} = {...}`)
    else if (b == null) bad(name, `style.css :root declares no --${token}`)
    else if (a !== b) bad(name, `palette says ${a ?? '(missing)'}, CSS says ${b}`)
    else ok(name)
  }

  /* ② The DOM side must not go back to literals. `--text3` is excluded on
     purpose: OFFLINE borrows the grey scale rather than owning a colour (S1
     §3.2), so greying text out is not a status declaration. */
  const banned = new Map()
  for (const t of ['green', 'orange', 'red', 'accent', 'ok-ink', 'warn-ink', 'crit-ink', 'up', 'down']) {
    if (css[t]) banned.set(css[t], `--${t}`)
  }
  const hits = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'three') walk(p); continue }
      if (!/\.(vue|css)$/.test(e.name) || e.name === 'style.css') continue
      const text = readFileSync(p, 'utf8')
      text.split('\n').forEach((line, i) => {
        for (const [hex, token] of banned) {
          if (line.toLowerCase().includes(hex)) {
            hits.push(`${p.slice(SRC.length + 1)}:${i + 1}  ${hex.trim()} should be var(${token})`)
          }
        }
      })
    }
  }
  walk(SRC)
  if (hits.length) bad('组件内无状态色字面量 (S4 §1.2)', `\n      ${hits.join('\n      ')}`)
  else ok('组件内无状态色字面量 (S4 §1.2)')

  /* ③ three/*.js is allowed to name colours only through palette.js. */
  const threeFiles = readdirSync(join(SRC, 'three')).filter(f => f.endsWith('.js'))
  const raw = []
  for (const f of threeFiles) {
    const text = readFileSync(join(SRC, 'three', f), 'utf8')
    text.split('\n').forEach((line, i) => {
      // 0xRRGGBB or '#rrggbb' for the four states, straight into the renderer.
      if (/0x(3fb950|d29922|f85149|9aa0a6)\b/i.test(line) || /'#(3fb950|d29922|f85149|9aa0a6)'/i.test(line)) {
        raw.push(`three/${f}:${i + 1}  ${line.trim()}`)
      }
    })
  }
  if (raw.length) bad('three/*.js 的状态色只经 palette.js (S4 §1.2)', `\n      ${raw.join('\n      ')}`)
  else ok('three/*.js 的状态色只经 palette.js (S4 §1.2)')
}

/* ④ User-visible copy must not cite internal documents (S4 §1.5 禁则 1).
   Templates only: comments are where those citations belong. */
{
  const leaks = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.vue')) continue
      const text = readFileSync(p, 'utf8')
      const tpl = /<template>([\s\S]*?)<\/template>/.exec(text)?.[1] || ''
      // Strip HTML comments, then look for a doc/section citation in what is left.
      const visible = tpl.replace(/<!--[\s\S]*?-->/g, '')
      visible.split('\n').forEach((line, i) => {
        if (/产品方案|细化设计|隐患清单|§\s?\d/.test(line)) {
          leaks.push(`${p.slice(SRC.length + 1)}  ${line.trim()}`)
        }
      })
    }
  }
  walk(SRC)
  if (leaks.length) bad('可见文案无内部文档编号 (S4 §1.5)', `\n      ${leaks.join('\n      ')}`)
  else ok('可见文案无内部文档编号 (S4 §1.5)')
}

console.log(`\n[check-tokens] pass=${pass} fail=${failures.length}`)
process.exit(failures.length ? 1 : 0)
