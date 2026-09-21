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
    ['GROUND', 'bg', 'bg', '场景底色 = 页面底色'],
    /* 告警脉冲此前只有 WebGL 一个家（`palette.NEUTRAL.alarm`），DOM 侧没有 token，
       于是墙上那块闪红的文字一直画着两个没进过表的红。最稀缺的通道上反而没闸
       ——这一对补上之后，`alarm-flash` 关键帧读的就是这个 token。 */
    ['NEUTRAL', 'alarm', 'alarm', '告警脉冲：CRIT 的"更响"，两侧必须同一个红'],
  ]
  /* 结构族 12 对 — V3 翻暗第 2 刀（任务书 §6.1/§6.5）。
     第 1 刀把 §2.5 那族只发在 `:root`，可它的另一个家是 3D 的总线色，而 canvas
     读不到 CSS 变量、只能读 palette.js —— 于是"图例的紫"和"线的紫"从此可以各改
     各的，而本脚本一声不响。那正是本文件开头写的 H9 形状，也是它存在的理由，
     所以这一族必须进成对表而不是留在散文里。键名与 CSS token 名一一对应。
     两支**有意**不在表内：PCIe×1 不发新色、并入 pcie4（§2.5 补 2，x1/x4 靠线宽
     0.10/0.16 分档）；COOLANT 是物理对象色（冷却液），DOM 侧没有可对照的图例。 */
  const STRUCT_MEANING = {
    ddr: '总线 DDR', pcie16: '总线 PCIe×16', pcie4: '总线 PCIe×4',
    nvlink: '总线 NVLink', dmi: '总线 DMI', sata: '总线 SATA',
    cpu: '部件 CPU', ram: '部件内存', gpu: '部件显卡',
    storage: '部件存储', pch: '部件 PCH', nic: '部件网卡',
  }
  for (const [key, what] of Object.entries(STRUCT_MEANING)) {
    STATE_PAIRS.push(['STRUCT', key, key, `${what}：DOM 图例 ↔ 3D 线色（色表 §2.5）`])
  }
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
     §3.2), so greying text out is not a status declaration.

     V3 翻暗第 2.5 刀（任务书 §6.6）把这条闸的两个已知盲区补掉了 —— 它此前
     "在但管不着"：一整类 `状态色 + 手调 alpha` 的字面量从它眼皮底下过了两年。
       盲区 a) 它跳过 style.css 自身，而这类 tint 大多写在那儿。现在纳入扫描，
              只豁免 `:root` 那一段 —— 那里是 token 的**定义家**，不是消费者，
              而且它由上面的成对表单独钉住；连它一起扫会误报，因为 §2.5 里
              `--ddr`／`--ram` 与 `--accent` **有意同值**（部件色＝所挂总线色），
              在 :root 里一个 hex 出现在别的 token 名下是合法事实，不是漂移。
       盲区 b) 它只匹配 `#rrggbb`。现在同时匹配 `rgb()/rgba()` 三元组：把每支
              token 的值换算成三元组再比，逗号式与斜杠式都认。
     两条都只是**补覆盖面**：不新增判据、不新增色值，banned 集与原来同一支。 */
  const banned = new Map()
  const triplePattern = (hex, sep) => {
    const n = parseInt(hex.slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    // `(?![\d.])` so --red's 34 does not match somebody else's 345.
    const num = (v) => `${v}(?![\\d.])`
    return new RegExp(`rgba?\\(\\s*${num(r)}${sep}${num(g)}${sep}${num(b)}\\s*[^)]*\\)`, 'i')
  }
  for (const t of ['green', 'orange', 'red', 'alarm', 'accent', 'up', 'down']) {
    // 同值只留先出现的那个名字。这七支今天互不同值（文字档一族按 R-2 删除后，
    // 原先撑住这条去重的 red/crit-ink 同值情形已经没有了），所以此判据当前是空
    // 跑的；留着是因为将来任何一支与状态色同值时，提示语该指向面色而不是后写入者。
    if (css[t] && !banned.has(css[t])) banned.set(css[t], `--${t}`)
  }
  const ROOT_RANGE = (() => {
    const m = /:root\s*\{[\s\S]*?\n\}/.exec(CSS)
    if (!m) return null
    const line = (idx) => CSS.slice(0, idx).split('\n').length
    return [line(m.index), line(m.index + m[0].length)]
  })()
  const hits = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'three') walk(p); continue }
      if (!/\.(vue|css)$/.test(e.name)) continue
      const text = readFileSync(p, 'utf8')
      const rel = p.slice(SRC.length + 1)
      text.split('\n').forEach((line, i) => {
        if (e.name === 'style.css' && ROOT_RANGE && i + 1 >= ROOT_RANGE[0] && i + 1 <= ROOT_RANGE[1]) return
        for (const [hex, token] of banned) {
          const found = line.toLowerCase().includes(hex) ? hex
            : triplePattern(hex, '\\s*,\\s*').exec(line)?.[0]
            ?? triplePattern(hex, '\\s+').exec(line)?.[0]
          if (found) {
            hits.push(`${rel}:${i + 1}  ${found.trim()} should be var(${token})`)
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
