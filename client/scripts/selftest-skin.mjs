/**
 * selftest-skin.mjs — V3 包 5「预算闸」：换皮这件事到底欠着多少，用读数说话
 *
 * 本文件**只加断言**，`client/src/**` 与 `server/src/**` 一个字节都没动（派单硬约束 1）。
 * 它落完之后画面必然一模一样——这句话的可核对形式就是"本包唯一的改动是 scripts/ 与台账"。
 *
 * 为什么要有这个文件（事故背景，别跳过）
 * ----------------------------------
 * 包 4 给 roster 加了 `form_factor` 列，服务端全部就绪，但 `client/src/lib/topology-vm.js`
 * 的 `topologyViewModel()` 是一份**字段白名单**，漏了这个键 ⇒ 整整一天"改了但屏上什么都不变"：
 * 不报错、不红、墙上照样有形状（`silhouetteTierOf` 读不到声明就静默落回按机名猜）。
 * 那条洞是靠施工 agent 在自检里**打印**了一句"转发 = 0 处"才发现的，不是被任何断言拦住的。
 * `4f7961c` 补上了那一行，并留下一条只盯 `form_factor` 这**一个字段**的断言。
 * 本包把"这一个字段有闸"升成"这道门有闸"：下一个新增显示字段不能再靠运气被发现。
 *
 * 四族判据
 * ------
 *   族零 仪器自校准（剥注释这件事不许吞掉真声明）
 *   族一 DOM 侧已经收口，钉的是它别退化（style.css 家外恰 0 支）
 *   族二 两家之外的色值预算（≤ 基线，只许降不许升，逐文件明细）
 *   族三 那道门：皮读到的字段 ⊆ topologyViewModel 返回值的键集合
 *   族四 字号与动效时长的现状登记
 *
 * ⚠️ 族四的性质要说清楚：**它不是"这样设计挺好"，是"欠着这么多，先数清楚"**。
 *    全仓 `:root` 有 36 个变量却没有一个字阶档，11 档字号与 8 档时长记法各写各的。
 *    把它们搬成 token 会改画面（`max()` 与 `em` 的换算、声明优先级、作用域），那一圈
 *    要用户出场，本包画面必须零变化 ⇒ 这里只钉现状 + 挡住"再多一档"，**不搬任何 token**。
 *
 * 基线怎么降（唯一合法方式）
 * --------------------
 * 把字面量搬进两家（`style.css` 的 `:root` / `lib/palette.js`），然后把下面那几个
 * `BASELINE_*` 常量改小，commit message 里带上"从几降到几、搬了几支、屏上是否零变化"。
 * 把基线改大不叫"更新读数"，叫把本包存在的理由抹掉。
 *
 * 关于派单给的 142/82 与本文件实读的 138/78：那 4 支的差不归因于"派单写错了"就过去，
 * 它被 皮5 钉成了一条可重跑的断言（`0x7fffffff` 是 LCG 掩码，不是颜色）。
 *
 * Run: node client/scripts/selftest-skin.mjs   (exit 1 on failure)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

let pass = 0
const failures = []
/* 第二格是**读数**，不是装饰：这一包的交付物就是那些数，PASS 行不带上它们，
   跑的人还得回头去读代码才知道"0 支"到底是量出来的还是猜出来的。 */
const ok = (name, extra = '') => { pass++; console.log(`PASS  ${name}${extra ? `   ${extra}` : ''}`) }
const bad = (name, why) => { failures.push(name); console.log(`FAIL  ${name}\n      ${why}`) }

/* ==========================================================================
 * 仪器：剥注释
 * ========================================================================== */

/**
 * 为什么这是全文件最该被校准的一步：派单那 142 支的前提是"已剥掉注释"，而 `style.css`
 * 的注释里全在讲历史色值（`#cc0000`、`#66bb6a`、`rgba(255,255,252,…)`），不剥就全部
 * 偏大。但反过来剥过头更危险——**把真声明当注释吃掉，得到的 0 是个假 0**，而这一包
 * 通篇在判的就是"0 支"。所以这里同时交出注释区间，让 皮1 能证明"少掉的每一支都真的
 * 落在注释里"。
 *
 * 字符串里的 `//` 与 `/*` 不算注释开头（App.vue 的注释里有 `http://<server-ip>:5173`，
 * 先剥块注释再遇到它就不会把整行切掉——区间记录器就是为这种次序问题准备的）。
 */
function stripComments(text) {
  let out = ''
  const spans = []
  let i = 0
  let str = null
  const n = text.length
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (str) {
      out += c
      if (c === '\\') { out += text[i + 2] ?? ''; i += 3; continue }
      if (c === str) str = null
      i += 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') { str = c; out += c; i += 1; continue }
    if (c === '/' && d === '/') {
      const s = i
      while (i < n && text[i] !== '\n') i += 1
      spans.push([s, i])
      continue
    }
    if (c === '/' && d === '*') {
      const s = i
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i += 1 }
      i = Math.min(i + 2, n)
      spans.push([s, i]); out += ' '
      continue
    }
    if (text.startsWith('<!--', i)) {
      const s = i
      const e = text.indexOf('-->', i)
      const stop = e < 0 ? n : e + 3
      for (let k = i; k < stop; k++) if (text[k] === '\n') out += '\n'
      i = stop; spans.push([s, i]); out += ' '
      continue
    }
    out += c
    i += 1
  }
  return { text: out, spans }
}

const inSpan = (spans, at) => spans.some(([a, b]) => at >= a && at < b)

/* ==========================================================================
 * 仪器：色值尺子
 * ========================================================================== */

/**
 * 派单给的四支模式：`#rrggbb` / `0xrrggbb` / `rgba(` / `hsla(`。
 * 两条右界 `(?![0-9a-fA-F])` 是本文件与派单唯一的口径差，而那 4 支的差被 皮5 钉住了：
 * 不钉右界时 `0x7fffffff`（一个 LCG 的掩码）会被当两支 `0xrrggbb` 吃进来。
 */
const COLOR_STRICT = /#[0-9a-fA-F]{6}(?![0-9a-fA-F])|\b0[xX][0-9a-fA-F]{6}(?![0-9a-fA-F])|rgba\(|hsla\(/g
const COLOR_LOOSE = /#[0-9a-fA-F]{6}|0[xX][0-9a-fA-F]{6}|rgba\(|hsla\(/g
/** 派单那四支模式**看不见**的写法：CSS 允许的三位缩写。它当然是颜色。 */
const COLOR_SHORT = /#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g

const HOME_CSS = 'style.css'
const HOME_PAL = join('lib', 'palette.js')

function listSourceFiles(root) {
  const out = []
  if (!existsSync(root)) return out
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (['.js', '.vue', '.css'].includes(extname(e.name))) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** 一棵根下的全部源码，剥注释后的缓存。 */
function corpus(root = SRC) {
  return listSourceFiles(root).map((p) => {
    const raw = readFileSync(p, 'utf8')
    const { text, spans } = stripComments(raw)
    return { abs: p, rel: relative(root, p).replace(/\\/g, '/'), raw, stripped: text, spans }
  })
}

const FILES = corpus()

/** 家外（两家之外）的色值明细。返回 { total, files, detail }。 */
function outsideHomes(root = SRC) {
  const detail = new Map()
  let total = 0
  for (const f of corpus(root)) {
    if (f.rel === 'style.css' || f.rel === 'lib/palette.js') continue
    const hits = (f.stripped.match(COLOR_STRICT) || []).length
    if (hits) detail.set(f.rel, hits)
    total += hits
  }
  return { total, files: root === SRC ? FILES.length : listSourceFiles(root).length, detail }
}

/**
 * 一把尺子的两种"0"必须分开：真的收口了，与什么都没扫到。
 * 派单纪律 R-6 在本包的第二种形态——它不返回色值数，它返回**裁决**，
 * 扫不到文件时永远是 blind，永远不会是 ok。
 */
function verdictOutsideHomes(baseline, root = SRC) {
  const r = outsideHomes(root)
  if (!r.files) return { kind: 'blind', why: `扫描根 ${root} 下一个 .js/.vue/.css 都没读到 ⇒ "0 支"不算读数，尺子瞎了`, ...r }
  if (!r.detail.size && !r.total) return { kind: 'blind', why: '扫到了文件却一支家外色值都没有 ⇒ 先怀疑尺子，再相信 0', ...r }
  return { kind: r.total > baseline ? 'over' : 'ok', ...r }
}

/* ==========================================================================
 * 族零 · 仪器自校准
 * ========================================================================== */

{
  let rawAll = 0, strippedAll = 0, inComment = 0
  const unexplained = []
  for (const f of FILES) {
    const rawHits = [...f.raw.matchAll(COLOR_STRICT)]
    const strippedHits = (f.stripped.match(COLOR_STRICT) || []).length
    const commented = rawHits.filter((m) => inSpan(f.spans, m.index)).length
    rawAll += rawHits.length
    strippedAll += strippedHits
    inComment += commented
    /* 闭合式：剥前总数 − 落在注释区间里的 = 剥后总数。少掉的每一支都必须能被
       "它在注释里"解释掉，解释不了的就是尺子多吃了。 */
    if (rawHits.length - commented !== strippedHits) {
      unexplained.push(`${f.rel}: 剥前 ${rawHits.length}、注释内 ${commented}、剥后 ${strippedHits}（应相等）`)
    }
  }
  const name = '皮1 剥注释这把尺子不吞真声明（全文 = 注释内 + 代码内，三项闭合）'
  if (inComment === 0) bad(name, '注释区间里一支色值都没找到 ⇒ 区间记录器没工作，后面所有"家外 0 支"都不可信')
  else if (unexplained.length) bad(name, `有文件的读数对不上：\n      ${unexplained.join('\n      ')}`)
  else ok(name, `（全文 ${rawAll} 支 = 注释内 ${inComment} + 代码内 ${strippedAll}，剥后实读 ${strippedAll}）`)
}

/* ==========================================================================
 * 族一 · DOM 侧已经收口，钉的是它别退化
 * ========================================================================== */

{
  const css = FILES.find((f) => f.rel === 'style.css')
  const m = /:root\s*\{([\s\S]*?)\n\}/.exec(css.stripped)
  const inside = m ? ((m[1].match(COLOR_STRICT) || []).length) : -1
  const all = (css.stripped.match(COLOR_STRICT) || []).length
  const outside = all - inside
  const BASELINE_INSIDE_ROOT = 29
  const name = '皮2 style.css 在 :root 之外的色值字面量恰 0 支（DOM 侧收口不许退化）'
  /* 正对照必需：同一条尺子在 :root 之内读到 29 支。读不到就说明这把尺子看不见
     style.css 的色值，那个 0 是"没扫到"而不是"收口了"。 */
  if (inside !== BASELINE_INSIDE_ROOT) {
    bad(name, `正对照失败：:root 之内读到 ${inside} 支（应为 ${BASELINE_INSIDE_ROOT}）⇒ 尺子瞎了，"家外 0 支"不算读数。`
      + `\n      若你确实增删了 :root 里的色值，请连同这个数一起改，并说明屏上是否零变化`)
  } else if (outside !== 0) {
    bad(name, `家外读到 ${outside} 支。搬回 :root 的 token，或在 lib/palette.js 里安家（canvas 读不到 CSS 变量才有两家这回事）`)
  } else ok(name, `（正对照：同一条尺子在 :root 之内读到 ${inside} 支，全文件 ${all} 支）`)
}

/* ==========================================================================
 * 族二 · 两家之外的色值预算
 * ========================================================================== */

/* 基线：两家之外的色值字面量。派单写的读数是 82，本文件实读 **78**，差的 4 支不是
   "派单记错"，是尺子没钉右界把 `TopologyRenderer.js:247/282` 各两次的 `0x7fffffff`
   （LCG 掩码）吃了进去——那 4 支由 皮5 单独钉成可重跑的事实，不静默改成实读值。
   降低这个基线的唯一合法方式（派单原话）：把字面量搬进两家，并附读数。 */
const BASELINE_OUTSIDE_HOMES = 78

{
  const v = verdictOutsideHomes(BASELINE_OUTSIDE_HOMES)
  const detail = [...v.detail].sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f}=${c}`).join('  ')
  const name = `皮3 两家之外的色值 ≤ 基线 ${BASELINE_OUTSIDE_HOMES}（只许降不许升）`
  if (v.kind === 'blind') bad(name, v.why)
  else if (v.kind === 'over') bad(name, `实读 ${v.total} 支 > 基线 ${BASELINE_OUTSIDE_HOMES}。逐文件：${detail}`)
  else ok(name, `（实读 ${v.total} 支 / 预算 ${BASELINE_OUTSIDE_HOMES}）\n      逐文件：${detail}`)
}

{
  /* 这条不判生产代码，判的是**这把尺子**：把扫描根换成一个肯定扫不到的路径，
     它必须报"尺子瞎了"，不许报"通过"。派单点名的正对照，形式是反向的——
     已知应该红的写法必须真的红，否则上面那个 ≤ 是永远为真的空断言。 */
  const bogus = join(SRC, '__definitely_not_a_source_dir__')
  const v = verdictOutsideHomes(BASELINE_OUTSIDE_HOMES, bogus)
  const real = verdictOutsideHomes(BASELINE_OUTSIDE_HOMES)
  const name = '皮4 同一把尺子喂一个扫不到的根 ⇒ 必须判"尺子瞎了"而不是"通过"（族二判据的正对照）'
  if (v.kind !== 'blind') bad(name, `瞎根返回了 ${v.kind}（total=${v.total}）⇒ ≤ 判据是空跑的，它拦不住任何事`)
  else if (real.kind === 'blind') bad(name, '瞎根判对了，但真根也判瞎 ⇒ 还是瞎')
  else ok(name, `（瞎根：files=${v.files} ⇒ blind；真根：files=${real.files} ⇒ ${real.kind}）`)
}

{
  /* 派单的 142/82 与实读的 138/78 之间那 4 支，必须有一个名字、有一处站点、有一条断言。
     不钉住的话，下一个读到这行的人只会看见 78，然后以为派单写错了——那正是"数字对不上
     就自己改成实际值"，是派单明确禁止的动作。 */
  const loose = outsideHomes(SRC)
  let looseTotal = 0
  const longTokens = []
  for (const f of FILES) {
    if (f.rel === 'style.css' || f.rel === 'lib/palette.js') continue
    const t = f.stripped
    looseTotal += (t.match(COLOR_LOOSE) || []).length
    for (const m of t.matchAll(COLOR_LOOSE)) {
      if (m[0].endsWith('(')) continue // rgba(/hsla( 后面本来就跟数字，不是"被截断的长十六进制"
      const after = t[m.index + m[0].length]
      if (!after || !/[0-9a-fA-F]/.test(after)) continue
      let j = m.index + m[0].length
      while (j < t.length && /[0-9a-fA-F]/.test(t[j])) j++
      longTokens.push({ tok: t.slice(m.index, j), where: `${f.rel}:${t.slice(0, m.index).split('\n').length}` })
    }
  }
  const strictTotal = loose.total
  const extras = longTokens.map((x) => x.tok)
  const name = '皮5 派单读数 82 与实读 78 的差 = 4 支非色值的长十六进制（钉死归因，不许静默改数）'
  const allMasks = extras.length === 4 && extras.every((t) => /^0x7fffffff$/i.test(t))
  if (looseTotal !== strictTotal + longTokens.length) {
    bad(name, `自洽失败：不钉右界读到 ${looseTotal}，钉了右界 ${strictTotal}，而"被截断的长字面量"只有 ${longTokens.length} 处 ⇒ 两把尺子的差解释不平`)
  } else if (!allMasks) {
    bad(name, `差值不是预期的 4 支 0x7fffffff，而是 ${JSON.stringify(longTokens)}`
      + `\n      ⇒ 有家外文件新增长十六进制字面量，先弄清它是不是颜色，再动基线`)
  } else if (looseTotal !== 82) {
    bad(name, `不钉右界的同一批文件读到 ${looseTotal} 支，与派单的 82 不符 ⇒ 家外语料变过（看 皮3 的逐文件明细），`
      + `要么搬进了两家、要么多了一支长十六进制。这条要跟着改，因为 皮3 的基线也是从这同一批数里来的`)
  } else ok(name, `（不钉右界 ${looseTotal} ＝ 实读 ${strictTotal} ＋ ${longTokens.map((x) => x.where).join(' ')}，全是 LCG 掩码不是色）`)
}

/* 三位缩写（#fff）是派单那四支模式**看不见**的色值。它当然是颜色，而且就在两家之外。
   把它并进店外的预算数会改掉派单给的基线口径，所以另立一本账、同样只许降不许升。 */
const BASELINE_SHORT_HEX = 6

{
  const detail = new Map()
  let total = 0
  for (const f of FILES) {
    if (f.rel === 'style.css' || f.rel === 'lib/palette.js') continue
    const n = (f.stripped.match(COLOR_SHORT) || []).length
    if (n) detail.set(f.rel, n)
    total += n
  }
  const name = `皮6 三位缩写 #rgb（族二那把尺子的盲区）≤ 基线 ${BASELINE_SHORT_HEX}（只许降不许升）`
  if (!detail.size) bad(name, '一支都没扫到 ⇒ 先怀疑尺子（正对照失败），再相信这个 0')
  else if (total > BASELINE_SHORT_HEX) bad(name, `实读 ${total} 支 > 基线 ${BASELINE_SHORT_HEX}：${[...detail].map(([k, v]) => `${k}=${v}`).join('  ')}`)
  else ok(name, `（实读 ${total} 支：${[...detail].map(([k, v]) => `${k}=${v}`).join('  ')}。这六支全是按钮上的 #fff，收进 :root 才算还账）`)
}

/* ==========================================================================
 * 族三 · 那道门：皮读到的字段必须是视图模型键集合的子集
 * ========================================================================== */

/** 从 `{` 之后做括号配对，返回配对 `}` 之前的内容（不含两端）。 */
function braceBody(text, openAt) {
  let depth = 0
  for (let i = openAt; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return text.slice(openAt + 1, i) }
  }
  return null
}

/**
 * topologyViewModel() 返回对象字面量的**顶层**键。
 * 判"顶层"的方式：括号深度为 0，且标识符前一个有意义字符是 `{` 或 `,`
 * （后者挡住 `a ? b : c` 里那个被误当键的 `b`，也挡住 `x.y:` 这类嵌套取值）。
 * 这条判据自己也要被证明不是摆设——所以它必须读出恰 9 个，且 `links` 内层那五个
 * 键（key/name/rtt/loss/level）**不许**出现在结果里：出现了就说明深度判据没起作用，
 * 白名单会被虚报的键撑宽，那道门就漏风。
 */
function viewModelKeys() {
  const f = FILES.find((x) => x.rel === 'lib/topology-vm.js')
  if (!f) return null
  const text = f.stripped
  const head = text.indexOf('export function topologyViewModel')
  if (head < 0) return null
  const arrow = text.indexOf('({', head)
  if (arrow < 0) return null
  const body = braceBody(text, text.indexOf('{', arrow))
  if (body == null) return null
  const keys = []
  let depth = 0
  let prevSig = '{'
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (/\s/.test(c)) continue
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i
      while (j < body.length && /[A-Za-z0-9_$]/.test(body[j])) j++
      const word = body.slice(i, j)
      let k = j
      while (k < body.length && /\s/.test(body[k])) k++
      if (body[k] === ':' && body[k + 1] !== ':' && depth === 0 && (prevSig === '{' || prevSig === ',')) keys.push(word)
      prevSig = body[j - 1]
      i = j - 1
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    prevSig = c
  }
  return keys
}

/** 文件里的函数/方法签名：name -> 形参名数组。 */
function paramLists(text) {
  const out = new Map()
  for (const m of text.matchAll(/\bfunction\s+([\w$]+)\s*\(([^)]*)\)/g)) out.set(m[1], splitParams(m[2]))
  for (const m of text.matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)) out.set(m[1], splitParams(m[2]))
  for (const m of text.matchAll(/\basync\s+([\w$]+)\s*\(([^)]*)\)\s*\{/g)) out.set(m[1], splitParams(m[2]))
  for (const m of text.matchAll(/\b([\w$]+)\s*\(([^()]*)\)\s*\{/g)) if (!out.has(m[1])) out.set(m[1], splitParams(m[2]))
  return out
}
function splitParams(s) {
  return s.split(',').map((p) => p.trim().replace(/\s*=.*$/, '').replace(/[{}]$/, '').trim()).filter(Boolean)
}
/** 顶层实参切分：只在不处于括号/花括号内时切逗号。 */
function splitArgs(s) {
  const out = []
  let depth = 0, cur = ''
  for (const c of s) {
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim())
}

/**
 * 视图模型记录在皮侧的**把手名**——不写死，从文件里推：
 *   起点：入口方法的那个数组形参；
 *   规则一：数组的 forEach/map/filter/find/some/every 回调形参 ⇒ 记录把手；
 *   规则二：实参恰好是已知把手的调用 ⇒ 被调函数的同位形参也是把手（含跨文件，
 *           被调方是本文件 import 进来的符号时，跟到它的源文件去，只跟一跳）。
 * 为什么非要推而不是列一张名单：`4f7961c` 那次事故的形状就是"名单少一项"。
 * 把手名单同样会被少一项，所以 皮10 用一次反向覆盖率检查钉它。
 */
function followRecords(entry) {
  const f = FILES.find((x) => x.rel === entry.file)
  const text = f.stripped
  const imports = new Map()
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const mod = m[2].replace(/^(\.\.)+\/?/, '')
    for (const nm of m[1].split(',').map((s) => s.trim()).filter(Boolean)) imports.set(nm, mod)
  }
  const local = paramLists(text)
  const arrays = new Set([entry.arrayParam])
  const records = new Set()
  const hops = new Map()   // 跨文件：module -> {fn -> Set(param)}
  let changed = true
  while (changed) {
    changed = false
    for (const m of text.matchAll(/\b([\w$]+)\.(?:forEach|map|filter|find|findIndex|some|every|flatMap|reduce)\s*\(\s*\(?\s*([\w$]+)/g)) {
      if (arrays.has(m[1]) && m[2] !== '_' && !records.has(m[2])) { records.add(m[2]); changed = true }
    }
    for (const m of text.matchAll(/\b([\w$]+)\s*\(\s*([^()]*?)\s*\)/g)) {
      const callee = m[1]
      const args = splitArgs(m[2])
      const idx = args.findIndex((a) => records.has(a))
      if (idx < 0) continue
      if (local.has(callee)) {
        const p = local.get(callee)[idx]
        if (p && !records.has(p)) { records.add(p); changed = true }
      }
      if (imports.has(callee)) {
        const mod = imports.get(callee)
        const seen = hops.get(mod) || {}
        if (!seen[callee]) { seen[callee] = idx; hops.set(mod, seen) }
      }
    }
  }
  /* 跨文件那一跳：在被调方源文件里定位同名导出函数，取其形参名，只扫它自己的函数体。 */
  const scopes = [{ file: entry.file, text, handles: [...records], lineOffset: 0 }]
  for (const [mod, calls] of hops) {
    const target = FILES.find((x) => x.rel === mod)
    if (!target) continue
    for (const [fn, argPos] of Object.entries(calls)) {
      const head = new RegExp(`function\\s+${fn}\\s*\\(([^)]*)\\)`).exec(target.stripped)
      if (!head) continue
      const p = splitParams(head[1])[argPos]
      if (!p) continue
      const openAt = target.stripped.indexOf('{', head.index + head[0].length - 1)
      const body = braceBody(target.stripped, openAt)
      if (body == null) continue
      const lineOffset = target.stripped.slice(0, openAt + 1).split('\n').length - 1
      scopes.push({ file: mod, text: body, handles: [p], via: `${fn}()`, lineOffset })
    }
  }
  return { scopes, records: [...records], arrays: [...arrays], imports }
}

/** 皮侧读到的字段：{ file, handle, prop, line, where } */
function readsInScopes(scopes) {
  const out = []
  for (const s of scopes) {
    for (const h of s.handles) {
      const re = new RegExp(`\\b${h}\\??\\.([A-Za-z_$][\\w$]*)`, 'g')
      for (const m of s.text.matchAll(re)) {
        const line = s.text.slice(0, m.index).split('\n').length + (s.lineOffset || 0)
        out.push({ file: s.file, handle: h, prop: m[1], line, where: `${s.file}${s.via ? `‹${s.via}›` : ''}:${line}` })
      }
    }
  }
  return out
}

const ENTRY = { file: 'three/ClusterTopologyRenderer.js', method: 'update', arrayParam: 'nodes' }
const EXPECTED_VM_KEYS = ['id', 'name', 'deviceLevel', 'linkLevel', 'online', 'absent', 'load', 'links', 'form_factor']

const VM_KEYS = viewModelKeys()
const FLOW = VM_KEYS ? followRecords(ENTRY) : null
const READS = FLOW ? readsInScopes(FLOW.scopes) : []
const READ_PROPS = new Set(READS.map((r) => r.prop))

{
  const name = '皮7 topologyViewModel 的顶层键抽得出来 = 那 9 个（这道门的白名单本身先要有读数）'
  if (!VM_KEYS) bad(name, `没从 ${ENTRY.file === '' ? '' : 'lib/topology-vm.js'} 里抽出返回对象字面量 ⇒ 后面两条判据无从谈起`)
  else {
    const missing = EXPECTED_VM_KEYS.filter((k) => !VM_KEYS.includes(k))
    const extra = VM_KEYS.filter((k) => !EXPECTED_VM_KEYS.includes(k))
    /* 内层 links 的键漏到顶层 = 深度判据失效的显式症状，单独点名，别混进 extra。 */
    const leakedInner = ['key', 'rtt', 'loss', 'level'].filter((k) => VM_KEYS.includes(k))
    if (leakedInner.length) bad(name, `内层 links 的键漏到了顶层：${leakedInner.join('/')} ⇒ 深度判据失效，白名单会被虚报撑宽`)
    else if (missing.length || extra.length) bad(name, `抽到 ${VM_KEYS.length} 个 [${VM_KEYS.join(', ')}]；缺 ${missing.join('/') || '—'}，多 ${extra.join('/') || '—'}`)
    else ok(name, `（${VM_KEYS.length} 个：${VM_KEYS.join(', ')}）`)
  }
}

{
  const name = '皮8 那道门：皮读到的字段 ⊆ topologyViewModel 的键集合（漏转发当场红，不再靠打印发现）'
  if (!VM_KEYS || !FLOW) bad(name, '白名单或把手推导失败 ⇒ 门没建成')
  else {
    const blind = FLOW.records.length === 0 || READS.length === 0
    const wl = new Set(VM_KEYS)
    const violations = READS.filter((r) => !wl.has(r.prop))
    const seen = [...READ_PROPS].sort().join(', ')
    if (blind) bad(name, `把手=${FLOW.records.join('/') || '无'}、读到 0 处 ⇒ 扫描什么都没看见，"⊆ 白名单"是空话`)
    else if (violations.length) {
      const uniq = [...new Set(violations.map((v) => v.prop))]
      bad(name, `皮读了 ${uniq.join('/')} 而 topologyViewModel 没转发 ⇒ 该字段到屏上是 undefined，静默落回默认值（form_factor 事故同形）。\n      `
        + violations.map((v) => `${v.where} ${v.handle}.${v.prop}`).join('\n      '))
    } else ok(name, `（把手 ${FLOW.records.join('/')||'—'}＋跨文件一跳，读到 ${READS.length} 处、涉及字段 ${seen}）`)
  }
}

{
  /* 白名单不是摆设的证法：**在同一条扫描、同一份读数上**做减法。
     故意把 load / form_factor 从白名单里抽掉，皮8 那条判据必须立刻把它们算成违规。
     为什么用构造式而不是"改一次生产文件再看红不红"：改文件是一次性证据，跑在自检里
     是每次 check 都重做一次。派单要求的变异实验（真的去改 topology-vm.js）本包也做了，
     读数写在对应 commit message 里；两者不互相替代。
     form_factor 这一支同时是历史事故的复现：它的读取点在 lib/silhouette.js 的
     silhouetteTierOf 里，抽掉它就等于回到 `4f7961c` 之前的那一天。 */
  const wl = new Set(VM_KEYS || [])
  const probes = ['load', 'form_factor']
  const rows = probes.map((k) => {
    const hits = READS.filter((r) => r.prop === k)
    return { k, n: hits.length, where: hits.map((h) => h.where).join(' '), inWl: wl.has(k) }
  })
  const dead = rows.filter((r) => r.n === 0 || !r.inWl)
  const name = '皮9 这道门有牙：故意抽掉 load / form_factor，同一条扫描立刻变红（构造式正对照）'
  if (!READS.length) bad(name, '没有可读的样本，牙无从证明')
  else if (dead.length) bad(name, `${dead.map((r) => `${r.k}: 读到 ${r.n} 处、在白名单=${r.inWl}`).join('；')}`
    + `\n      ⇒ 抽掉它不会变红 ⇒ 白名单里那一项是摆设，这道门挡不住它`)
  else ok(name, `（${rows.map((r) => `${r.k}=${r.n} 处 @ ${r.where}`).join('；')}）`)
}

{
  /* 作用域不腐烂：入口签名一改，推导集会静默变空，皮8 就会变成"读到 0 处 ⊆ 白名单"
     那种最难看的假绿。这里两头都钉：入口还在不在，以及有没有**没被登记**的把手。 */
  const f = FILES.find((x) => x.rel === ENTRY.file)
  const sig = f ? new RegExp(`\\b${ENTRY.method}\\s*\\(([^)]*)\\)`).exec(f.stripped) : null
  const params = sig ? splitParams(sig[1]) : []
  const wl = new Set(VM_KEYS || [])
  /* 反向覆盖率：不靠推导集自己查自己（那永远成立），而是把**整个作用域文件**里所有
     `标识符.属性` 都扫一遍，凡是被读了 ≥2 个白名单键的标识符，事实上就是记录把手；
     它要不在扫描登记范围内，就说明推导漏了一个入口——那正是"名单少一项"的形状。
     按 文件#标识符 记账，不按标识符全局记：`rec` 在 A0 渲染器里是**场景记录**
     （group/body/bodyMat…），在 lib/silhouette.js 的 silhouetteTierOf 里才是视图模型记录，
     同名不同物，全局记会把前者冤枉成漏网。 */
  /* 噪声：从 lib/palette.js 进来的那几张表（NEUTRAL.absent 读的是一个**色值键**，
     与视图模型的 absent 同名不同物）。识别方式是机械的——凡出现在该文件的
     `import {…} from '../lib/palette.js'` 里的绑定名，都不可能是记录把手。 */
  const paletteNoise = new Set()
  for (const rel of [...new Set(FLOW ? FLOW.scopes.map((s) => s.file) : [])]) {
    const text = FILES.find((f) => f.rel === rel)?.stripped
    if (!text) continue
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*palette\.js['"]/g)) {
      for (const nm of m[1].split(',').map((s) => s.trim()).filter(Boolean)) paletteNoise.add(nm)
    }
  }
  const byHandle = new Map()
  for (const rel of [...new Set(FLOW ? FLOW.scopes.map((s) => s.file) : [])]) {
    const text = FILES.find((f) => f.rel === rel)?.stripped
    if (!text) continue
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\??\.([A-Za-z_$][\w$]*)/g)) {
      if (!wl.has(m[2]) || paletteNoise.has(m[1])) continue
      const key = `${rel}#${m[1]}`
      const s = byHandle.get(key) || new Set()
      s.add(m[2])
      byHandle.set(key, s)
    }
  }
  const scanned = new Set(FLOW ? FLOW.scopes.flatMap((s) => s.handles.map((h) => `${s.file}#${h}`)) : [])
  /* 阈值取 1 而不是 2：取 2 的话"新加一个只读一个字段的把手"就漏过去了，而那正是
     下一个 form_factor 的形状。第一版这里写的是 2，量到 1 处噪声（`NEUTRAL.absent`
     ——色表里那支"离场灰"与视图模型的 absent 同名），改成"按来源排除色表绑定"之后
     阈值可以下到 1 而不错报。噪声不是靠放宽判据处理的，是靠认清那是什么东西。 */
  const MIN_KEYS = 1
  const undeclared = [...byHandle].filter(([k, set]) => set.size >= MIN_KEYS && !scanned.has(k)).map(([k]) => k)
  const derived = FLOW ? FLOW.records : []
  const scannedHandles = [...scanned].join(' / ')
  const strong = [...byHandle].filter(([, set]) => set.size >= MIN_KEYS)
  const name = `皮10 扫描作用域不腐烂：入口签名仍成立 ＋ 反向覆盖率（读过 ≥${MIN_KEYS} 个白名单键的把手都必须被扫到）`
  if (!sig) bad(name, `${ENTRY.file} 里找不到方法 ${ENTRY.method}( ⇒ 入口改了，去更新 ENTRY 并重读一遍这个文件`)
  else if (!params.includes(ENTRY.arrayParam)) bad(name, `${ENTRY.method}(${params.join(', ')}) 里没有 ${ENTRY.arrayParam} ⇒ 同上`)
  else if (undeclared.length) bad(name, `这些标识符被按视图模型的用法读了（≥${MIN_KEYS} 个白名单键）却不在扫描范围内：${undeclared.join(' / ')} ⇒ 扫描漏了把手`
    + `\n      若它是色表/参数表而不是记录，把它加进 paletteNoise 的识别方式里（别加名字，加来源特征）`)
  else if (!derived.length) bad(name, '推导出的把手集合为空 ⇒ 皮8 在空跑')
  else ok(name, `（入口 ${ENTRY.method}(${params.join(', ')}) 成立；A0 推导把手 ${derived.join('/')}；`
    + `反向覆盖：全量扫到 ${byHandle.size} 个候选标识符（噪声白名单挡掉 ${[...paletteNoise].join('/')} 这类色表绑定）、`
    + `强候选 ${strong.length} 个 [${strong.map(([k]) => k).join(' / ') || '—'}] 全部在册；在册把手 ${scannedHandles}）`)
}

console.log(`\n[selftest-skin] pass=${pass} fail=${failures.length}`)
process.exit(failures.length ? 1 : 0)

