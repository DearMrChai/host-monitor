/**
 * selftest-silhouette.mjs — 三档剪影与陈列架折行：交人眼之前，先把能核对的数读完
 *
 * 任务书 B §3 只要三条断言，全部从 `src/lib/silhouette.js` 导出的常量表算出来：
 *   (a) 三档两两在「高宽比」上分得开；
 *   (b) 每档投进 60×60 的槽口（判据① 那一排小图），宽/高像素两两不同；
 *   (c) 任何「归一化进同一个槽口」的写法必须让 (b) 判失败。
 *
 * (c) 同时是这把尺子自己的正对照：同一个谓词喂进归一化后的读数必须返回 false，
 * 否则 (b) 是一条永远为真的断言，量不出任何东西——色表纪律 R-6「返回 0 的扫描必须
 * 先喂正对照」在这里的形式是「判 separable 的闸必须先判出一次 not-separable」。
 *
 * 另加陈列架的可核对阈值与两条几何不变量（§1.1）：240px 槽宽、容器窄于 960px 折第二排、
 * 地牌不撞邻格、下层标签不压上层牌。后两条同时是自己那把尺子的正对照——判据在更小
 * 的槽距/排距下必须命中，且命中点会连同余量一起打出来。
 *
 * 深度不参与 (a)(b)：那一排小图是正视图（front elevation），投影里只看得见宽和高。
 * 三档的深度差留给 A1 详情页的斜视视角，不在这道闸上。
 *
 * Run: node client/scripts/selftest-silhouette.mjs   (exit 1 on failure)
 */
import { readFileSync } from 'node:fs'
import {
  SILHOUETTE_TIERS, SILHOUETTE_DEFAULT, silhouetteSize, silhouetteTierOf, SHELF, shelfGrid,
  shelfLayout, buildTierGeometry,
} from '../src/lib/silhouette.js'
import { plateSub } from '../src/lib/plate.js'
/* V3 包 4 步 3 追加：两族色要**当值比**（不是当文本比），所以从 palette.js 读进来。 */
import { STATE, LOAD } from '../src/lib/palette.js'

let pass = 0
const failures = []
const ok = (name) => { pass++; console.log(`PASS  ${name}`) }
const bad = (name, why) => { failures.push(name); console.log(`FAIL  ${name}\n      ${why}`) }
const r = (v, d = 1) => Number(v.toFixed(d))

/* ---------- 判据本身 ---------- */

const JUDGE_SLOT_PX = 60      // 判据① 那一排小图的边长（任务书 B §3(b)）
const MIN_PX = 1              // 宽和高各至少差 1px（60px 的 1.7%）才算分得开
const MIN_ASPECT_GAP = 1.5    // 高宽比至少差 1.5 倍（对数轴上的"一眼两种形状"）

const TIERS = ['laptop', 'mini', 'rack']
const PAIRS = [['laptop', 'mini'], ['laptop', 'rack'], ['mini', 'rack']]

/** 正视图投影：世界单位 → 小图像素。槽口宽度 = 每格的间距，不是尺寸的模子。 */
function project(tierKey, slotPx) {
  const s = silhouetteSize(tierKey)
  const pxPerUnit = slotPx / SHELF.slotPitchWorld
  return { w: s.width * pxPerUnit, h: s.height * pxPerUnit, d: s.depth * pxPerUnit }
}

/** 两档分不分得开：宽和高都要差出去（AND，不是 OR）。 */
function tellable(a, b) {
  const dw = Math.abs(a.w - b.w)
  const dh = Math.abs(a.h - b.h)
  return { separable: dw >= MIN_PX && dh >= MIN_PX, dw, dh }
}

/** 高宽比（h/w）差多少倍。形状读数，与绝对大小无关。 */
function aspectGap(a, b) {
  const ra = a.h / a.w
  const rb = b.h / b.w
  return { q: Math.max(ra, rb) / Math.min(ra, rb), ra, rb }
}

/* ---------- 表本身还在 §7.2 上（源），以及钉在 09-22 那版 mock 上（锁） ---------- */

const SPEC = {
  laptop: { h: 1, w: 16, d: 11 },   // 卧式薄板
  mini: { h: 1, w: 1.4, d: 1.6 },   // 卧式方盒
  rack: { h: 1, w: 8, d: 3 },       // 卧式超宽，§7.2 写的是 1:4~8:3
}

{
  const keys = Object.keys(SILHOUETTE_TIERS)
  const drift = TIERS.filter((k) => !keys.includes(k))
  if (keys.length === 3 && !drift.length) {
    ok(`三档在场、且没并成两档（09-22 裁定「继续切 124」）：${keys.join('/')}`)
  } else {
    bad('三档必须各自在场', `keys=${keys.join('/')} 缺=${drift.join('/') || '-'}`)
  }
}

{
  const wrong = []
  for (const k of TIERS) {
    const t = SILHOUETTE_TIERS[k]?.ratio
    if (!t || !SPEC[k]) { wrong.push(`${k}:无 ratio`); continue }
    for (const ax of ['h', 'w', 'd']) {
      if (Math.abs(t[ax] / SPEC[k][ax] - 1) > 1e-9) wrong.push(`${k}.${ax}=${t[ax]} 应为 ${SPEC[k][ax]}`)
    }
  }
  if (!wrong.length) {
    ok(`三档高:宽:深 = §7.2 字面值（笔记本 1:16:11 / 微型 1:1.4:1.6 / 机架 1:8:3）`)
  } else bad('三档比例必须留在 §7.2 上', wrong.join('; '))
}

{
  const w = SILHOUETTE_TIERS.rack.ratio.w
  if (w >= 4 && w <= 8) ok(`机架档宽倍数 ${w} 落在 §7.2 的 1:4~8:3 之内`)
  else bad('机架档宽倍数出界', `w=${w} 不在 [4,8]`)
  // 8 不是随便挑的上界：它就是他 09-22 挑中那版 mock（"卧式超宽 挺好的"）画的那个值。
  // 改成 4~7 仍在 §7.2 的字面范围内，但那会同时改掉笔记本档与机架档的宽度差——所以钉住。
  if (w === 8) ok('机架档钉在 8（他自己挑的那版 mock），要动这一格需要他点头')
  else bad('机架档宽倍数被挪了', `w=${w}，钉的是 8；这一改动会吃掉笔记本档与机架档的宽度差`)
}

/* ---------- (a) 高宽比两两可分 ---------- */

{
  const rows = []
  let allGood = true
  for (const [a, b] of PAIRS) {
    const g = aspectGap(project(a, JUDGE_SLOT_PX), project(b, JUDGE_SLOT_PX))
    const good = g.q >= MIN_ASPECT_GAP
    if (!good) allGood = false
    rows.push(`${a}↔${b} 高宽比 ${r(g.ra, 4)}:${r(g.rb, 4)} 差 ${r(g.q, 2)}×`)
  }
  const aspects = TIERS.map((k) => `${k} h/w=${r(silhouetteSize(k).height / silhouetteSize(k).width, 4)}`)
  if (allGood) ok(`判据(a) 三档高宽比两两可分（≥${MIN_ASPECT_GAP}×）：${aspects.join(' · ')}`)
  else bad('判据(a) 高宽比两两可分', '失败对：' + rows.join('; '))
  console.log(`      ${rows.join('\n      ')}`)
}

/* ---------- (b) 60×60 槽口里的宽高像素两两不同 ---------- */

const px60 = Object.fromEntries(TIERS.map((k) => [k, project(k, JUDGE_SLOT_PX)]))

{
  const rows = []
  let allGood = true
  for (const [a, b] of PAIRS) {
    const t = tellable(px60[a], px60[b])
    if (!t.separable) allGood = false
    rows.push(`${a}↔${b} Δ宽 ${r(t.dw)}px Δ高 ${r(t.dh)}px`)
  }
  const read = TIERS.map((k) => `${k} ${r(px60[k].w)}×${r(px60[k].h)}px`).join(' / ')
  if (allGood) ok(`判据(b) 60×60 槽口内三档宽高两两可分（≥${MIN_PX}px，AND）：${read}`)
  else bad('判据(b) 60×60 投影两两可分', rows.join('; '))
  console.log(`      ${rows.join('\n      ')}`)
  console.log(`      px/世界单位：小图档 ${r(JUDGE_SLOT_PX / SHELF.slotPitchWorld)}，墙上档 ${r(SHELF.slotWidthPx / SHELF.slotPitchWorld)}（槽宽 ${SHELF.slotWidthPx}px ÷ 槽距 ${SHELF.slotPitchWorld}）`)
}

{
  const over = TIERS.filter((k) => px60[k].w > JUDGE_SLOT_PX || px60[k].h > JUDGE_SLOT_PX)
  const maxW = Math.max(...TIERS.map((k) => px60[k].w))
  if (!over.length) ok(`判据(b) 补：三档都装得进 60×60（最宽 ${r(maxW)}px ≤ ${JUDGE_SLOT_PX}px），读数没被裁掉`)
  else bad('投影不得溢出 60×60 槽口', `溢出档：${over.join('/')}`)
}

/* ---------- (c) 「归一化进同一个槽口」必须失败（兼作尺子的正对照） ---------- */

/** 把一档等比缩放到刚好塞进 60×60 —— 这就是"归一化进槽口"那类写法。 */
function normalized(tierKey, slotPx) {
  const s = silhouetteSize(tierKey)
  const fit = Math.min(slotPx / s.width, slotPx / s.height, slotPx / s.depth)
  return { w: s.width * fit, h: s.height * fit, d: s.depth * fit }
}

{
  const norm = Object.fromEntries(TIERS.map((k) => [k, normalized(k, JUDGE_SLOT_PX)]))
  const t = tellable(norm.laptop, norm.rack)
  const read = TIERS.map((k) => `${k} ${r(norm[k].w)}×${r(norm[k].h)}px`).join(' / ')
  if (!t.separable) {
    ok(`判据(c) 归一化进同一槽口 → 同一把尺子判不可分（正对照生效）：${read}`)
  } else {
    bad('判据(c) 归一化必须失败', `谓词在归一化读数上仍判可分，说明它量不出东西：${read}`)
  }
  console.log(`      归一化后笔记本↔机架 Δ宽 ${r(t.dw, 2)}px Δ高 ${r(t.dh, 2)}px —— 宽被槽口吃平，真比例不许这样交`)
}

/* ---------- 真比例：绝对大小也是识别特征，不能全部顶到同一上限 ---------- */

{
  const maxDim = Object.fromEntries(TIERS.map((k) => {
    const s = silhouetteSize(k)
    return [k, Math.max(s.width, s.height, s.depth)]
  }))
  const clash = []
  for (const [a, b] of PAIRS) {
    if (Math.abs(maxDim[a] - maxDim[b]) < 1e-9) clash.push(`${a}=${b}=${r(maxDim[a], 3)}`)
  }
  const read = TIERS.map((k) => `${k} ${r(maxDim[k], 2)}`).join(' / ')
  if (!clash.length) ok(`真比例不归一化：三档绝对大小（世界单位最长边）互不相等 ${read}`)
  else bad('三档绝对大小必须不同', `相等对：${clash.join('; ')}`)
}

/* ---------- 陈列架折行：§1.1 要求那是一个可核对的数 ---------- */

{
  /* H34 的销账：`SHELF.wrapAtContainerWidthPx` 是一个生产侧零消费者的惰常量（折行是
     `shelfGrid` 现算的，没人读它），常量删了。但"删常量"不许顺手删成"删对账"——所以这一条
     换成一对必须同时成立的读数：
       反：这个键不许存在于 SHELF 里。谁把它加回来，这里红，红的原因是"复活了一个没人读的抄件"。
       正：量尺还在（`slotWidthPx` 240 ＋ `maxSlotsPerRow` 4 两个真源键），960 由算式当场算出，
           而且它**真的是墙**：恰好在 960px 排满 4 格一排，窄一像素就折成 3 格 2 排。
     没有正半边，反半边是永真的空话——把 `slotWidthPx` 一起删掉它也照样绿。 */
  const revived = 'wrapAtContainerWidthPx' in SHELF
  const derived = SHELF.maxSlotsPerRow * SHELF.slotWidthPx
  const at = shelfGrid(4, derived)
  const below = shelfGrid(4, derived - 1)
  const rulerOk = SHELF.slotWidthPx === 240 && SHELF.maxSlotsPerRow === 4 && derived === 960
  if (!revived && rulerOk && at.cols === 4 && at.rows === 1 && below.cols === 3 && below.rows === 2) {
    ok(`折行阈值只有一个家（算式）：SHELF 里不存在 wrapAtContainerWidthPx（H34 销账），${derived}px 由 maxSlotsPerRow ${SHELF.maxSlotsPerRow} × slotWidthPx ${SHELF.slotWidthPx}px 现算，且它是真墙——${derived}px 排 ${at.cols} 格 ${at.rows} 排 ／ ${derived - 1}px 折成 ${below.cols} 格 ${below.rows} 排`)
  } else {
    bad('折行阈值不许有第二个家，也不许连量尺一起删', `键复活=${revived}／量尺完好=${rulerOk}（slotWidthPx ${SHELF.slotWidthPx}、maxSlotsPerRow ${SHELF.maxSlotsPerRow}、现算 ${derived}）／${derived}px→${at.cols}列${at.rows}排／${derived - 1}px→${below.cols}列${below.rows}排`)
  }
}

{
  const probes = [
    [4, 1920, 4, 1], [4, 960, 4, 1], [4, 959, 3, 2], [5, 959, 3, 2],
    [7, 959, 3, 3], [8, 1600, 4, 2], [1, 240, 1, 1], [12, 1200, 4, 3],
  ]
  const wrong = []
  for (const [count, width, cols, rows] of probes) {
    const g = shelfGrid(count, width)
    if (g.cols !== cols || g.rows !== rows) wrong.push(`${count}台@${width}px → ${g.cols}列${g.rows}排，应为 ${cols}列${rows}排`)
  }
  if (!wrong.length) ok(`shelfGrid 八点实测折行（4台@960=1排 / 4台@959=2排 / 12台@1200=3排 …）`)
  else bad('折行算法与阈值不符', wrong.join('; '))
}

{
  const wrong = []
  for (let w = SHELF.slotWidthPx; w <= 2400; w += 1) {
    const g = shelfGrid(40, w)
    if (g.cols < 1) wrong.push(`${w}px 排出 0 列`)
    if (g.cols * SHELF.slotWidthPx > w) { wrong.push(`${w}px 却排 ${g.cols} 列 = ${g.cols * SHELF.slotWidthPx}px，溢出未折`); break }
    if (g.rows !== Math.ceil(40 / g.cols)) { wrong.push(`${w}px 排数不等于 ceil(台数/列数)`); break }
  }
  if (!wrong.length) ok(`容器 ${SHELF.slotWidthPx}~2400px 逐像素扫：每排放得下、溢出必折、排数=ceil(台数/列数)（2161 个宽度全过）`)
  else bad('折行不变量被破', wrong.join('; '))
}

/* ---------- 陈列架的几何不变量：地牌不撞邻格、下层标签不压上层牌 ---------- */

{
  const plates = TIERS.map((k) => [k, silhouetteSize(k).width + SHELF.plinthMargin * 2])
  const worst = plates.reduce((a, b) => (b[1] > a[1] ? b : a))
  const minPitch = Math.ceil(worst[1] * 10) / 10          // 不撞格的最小槽距（0.1 一档）
  const slack = SHELF.slotPitchWorld - worst[1]
  const wallPx = SHELF.slotWidthPx / SHELF.slotPitchWorld
  const clash = plates.filter(([, w]) => w > SHELF.slotPitchWorld + 1e-9).map(([k]) => k)
  if (clash.length) {
    bad('地牌不得溢出槽口（相邻两格会磨到牌）', `${clash.join('/')} 的地牌宽 > 槽距 ${SHELF.slotPitchWorld}`)
  } else if (worst[1] <= SHELF.slotPitchWorld - 1.5) {
    bad('槽距与最宽地牌脱节', `最宽地牌 ${r(worst[1], 2)} 而对岸在 ${SHELF.slotPitchWorld}：格子空出 ${r(SHELF.slotPitchWorld - worst[1], 2)} 世界单位，"240px 一格的量级"名存实亡`)
  } else {
    ok(`地牌不撞邻格：最宽 ${worst[0]} 地牌 ${r(worst[1], 2)} ≤ 槽距 ${SHELF.slotPitchWorld}（余量 ${r(slack, 2)} = 墙上 ${r(slack * wallPx)}px）`)
    console.log(`      正对照：同一条判据在槽距 ${r(minPitch - 0.1, 1)} 处即命中（${r(worst[1], 2)} > ${r(minPitch - 0.1, 1)}），最小可用槽距 ${minPitch}`)
  }
}

{
  const tallest = Math.max(...TIERS.map((k) => silhouetteSize(k).height))
  const tallestTier = TIERS.find((k) => Math.abs(silhouetteSize(k).height - tallest) < 1e-12)
  // 下层：机体顶 + 标签锚点 + 牌面半高；上层：地牌底面
  const labelTopY = SHELF.baseY - SHELF.bodySeatY + tallest + SHELF.labelAboveBody + SHELF.plateHalfHeight
  const upperPlateY = SHELF.baseY + SHELF.rowPitchWorld - SHELF.bodySeatY - SHELF.plinthThickness / 2
  const gap = upperPlateY - labelTopY
  const minRowPitch = labelTopY - SHELF.baseY + SHELF.bodySeatY + SHELF.plinthThickness / 2
  if (gap <= 0) bad('下层标签牌压上上层地牌', `间隙 ${r(gap, 2)} 世界单位`)
  else if (gap > 1.5) bad('两层排距脱节（架子被拉得过高）', `间隙 ${r(gap, 2)} 世界单位，最小可用排距只要 ${r(minRowPitch, 2)}`)
  else ok(`下层标签不压上层地牌：${tallestTier} 顶的标签与上层牌之间 ${r(gap, 2)} 世界单位（排距 ${SHELF.rowPitchWorld}，最小 ${r(minRowPitch, 2)}）`)
}

/* ---------- 档名是一眼能读出来的三个形状，不是一个颜色 ---------- */

{
  const labels = TIERS.map((k) => SILHOUETTE_TIERS[k].shortLabel)
  const dup = labels.filter((v, i) => labels.indexOf(v) !== i)
  // 长名里必须写清站姿（卧式）与形状（薄板/方盒/超宽），否则这档日后只能靠猜。
  const noShapeWord = TIERS.filter((k) => !/卧式/.test(SILHOUETTE_TIERS[k].label)
    || !/薄板|方盒|超宽/.test(SILHOUETTE_TIERS[k].label))
  if (!dup.length && !noShapeWord.length) {
    ok(`三档短名互不相同、长名各带站姿与形状词（${labels.join(' / ')}）—— 站姿+高宽比+大小之外不发明识别特征`)
  } else bad('档名规则被破', `重复=${dup.join('/')} 缺形状词=${noShapeWord.join('/')}`)
}

{
  /* 这张表是几何表，不是第二个颜色家：颜色只有 palette.js / style.css :root 两个家。
     尺子先喂正对照再允许它报"零命中"（色表纪律 R-6）——这里喂的正对照就是 palette.js
     自己的源码文本：本脚本里不写任何色值字面量，连正对照都是从唯一真源读进来的。 */
  const HEX = /#[0-9a-fA-F]{3,8}\b|0x[0-9a-fA-F]{6}\b/g
  const paletteSrc = readFileSync(new URL('../src/lib/palette.js', import.meta.url), 'utf8')
  const control = [...paletteSrc.matchAll(HEX)].map((m) => m[0])
  const tables = JSON.stringify({ SILHOUETTE_TIERS, SILHOUETTE_DEFAULT, SHELF })
  const hit = tables.match(HEX)
  if (control.length < 20) {
    bad('色值扫描缺正对照', `palette.js 里只量到 ${control.length} 个色值字面量，这条尺子不算数`)
  } else if (!hit) {
    ok(`几何表零色值（正对照：同一条正则从 palette.js 量到 ${control.length} 个，如 ${control.slice(0, 2).join(' / ')}）`)
  } else {
    bad('几何表里混进了色值', `命中 ${hit.join(', ')}；颜色只有 palette.js / :root 两个家`)
  }
}

/* ---------- 档名来自一个客户端纯函数（本包的临时家） ---------- */

{
  const cases = [
    [{ id: 'i9-12900H-124', name: '游戏本' }, 'laptop', 'host_id 词元'],
    [{ id: 'sim-tmpnote', name: '模拟-临时笔记本' }, 'laptop', 'display_name 关键词'],
    [{ id: 'ryzen-142', name: '影音服务器' }, 'rack', 'host_id 词元'],
    [{ id: 'sim-media', name: '模拟-影音服务器' }, 'rack', 'display_name 关键词'],
    [{ id: 'x99-01', name: '虚拟机柜' }, 'rack', 'x99 词元'],
    [{ id: 'sim-vectordb', name: '模拟-向量库机' }, 'mini', '默认档'],
    [{ id: 'unknown-host', name: '' }, 'mini', '空名也回落默认'],
  ]
  const wrong = []
  for (const [rec, want, why] of cases) {
    const got = silhouetteTierOf(rec)
    if (got !== want) wrong.push(`${rec.id}/${rec.name} → ${got}，应为 ${want}（${why}）`)
  }
  if (!wrong.length && SILHOUETTE_DEFAULT === 'mini') {
    ok(`档名纯函数 silhouetteTierOf(record)：${cases.length} 例全命中，未知形态回落「微型方盒」`)
  } else bad('档名判定与临时规则不符', wrong.join('; ') || `默认档=${SILHOUETTE_DEFAULT} 非 mini`)
}

{
  /* 纯函数必须是纯的：同一入参两次调用、以及调用方不改入参。
     包 3 会把这张表换成 roster 的形态列，届时删的就是这一段。 */
  const rec = { id: 'i9-12900H-124', name: '游戏本' }
  const before = JSON.stringify(rec)
  const a = silhouetteTierOf(rec)
  const b = silhouetteTierOf({ ...rec })
  if (a === b && JSON.stringify(rec) === before) ok('silhouetteTierOf 无副作用、可重复（输入只取 display_name / host_id 两个字符串）')
  else bad('档名函数不再单纯', `${a}/${b} rec=${JSON.stringify(rec)}`)
}

/* ==========================================================================
   V3 包 2 步 1 · 三条「单点验收」
   --------------------------------------------------------------------------
   上面那些断言量的是**读数**（三档分不分得开、折行折得对不对）。这一节量的是
   **改动点的数量**——用户要的是"想优化某个容器布局，我可以单独按模块去加强"，
   所以判法做成可核对的一句话：改某一档的形状 / 改折行规则 / 改牌面排版，
   各自要动的文件数必须是 1，且渲染器一行不动。
   写法上的规矩（色表纪律 R-6）：每一处「零命中」都当场喂一条**已知该命中**的
   输入给同一条模式当正对照，对照打不中就把这条判成 FAIL——一个抓不到东西的
   探针报 0，等于没测。对照源全部是仓库里的真文件（A1 的 TopologyRenderer.js
   本轮一行不碰，正好当"牌面 HTML 长什么样"的实物对照）。
   ========================================================================== */

const readSrc = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
const hitsOf = (text, re) => [...text.matchAll(new RegExp(re.source, 'g'))].length

/* 「单点」那几条数的是**代码**里的命中，不是散文里的提法。渲染器注释里出现
   `slotPitchWorld`，说的是"格子坐标我不再自己算"（这一版刚写下的解释）；把它算成
   坐标算式残留，等于要求我先删掉注释才能过——那条尺子就不再量东西了。
   所以先剥注释再扫。剥法是个小状态机（认 //、块注释、三种引号），它自己也可能咬到
   代码，于是留一道闸：剥完必须还读得到两个函数头，读不到＝尺子坏了，三条轴一律 FAIL。 */
const stripComments = (text) => {
  let out = ''
  let mode = 'code'
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const n = text[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 1; continue }
      if (c === '/' && n === '*') { mode = 'block'; i += 1; continue }
      if (c === "'") mode = 'sq'
      else if (c === '"') mode = 'dq'
      else if (c === '`') mode = 'tpl'
      out += c
      continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 1; continue }
      if (c === '\n') out += c            // 行结构留着，免得两行代码被接成一行
      continue
    }
    out += c                              // 字符串里的字面量是代码，不是散文
    if (c === '\\') { out += text[i + 1]; i += 1 }
    else if (c === "'" && mode === 'sq') mode = 'code'
    else if (c === '"' && mode === 'dq') mode = 'code'
    else if (c === '`' && mode === 'tpl') mode = 'code'
  }
  return out
}
const readCode = (rel) => stripComments(readSrc(rel))

const A0_SRC = readCode('three/ClusterTopologyRenderer.js')  // 本包的改造对象（只看代码）
const SIL_SRC = readCode('lib/silhouette.js')
const PLATE_SRC = readCode('lib/plate.js')
const A1_SRC = readSrc('three/TopologyRenderer.js')           // 只读：正对照 + 一行未动（全文，含它自己的注释）
const STATUS_SRC = readSrc('lib/status.js')

/** 剥注释的闸：三个单点判据共用的"尺子还灵不灵"读数。函数头之外还要读得到渲染器
 *  自己的两处代码——字符串里有单引号，状态机若被哪个字面量带偏，最先丢的就是这些。 */
const CODE_INTACT = /export function buildTierGeometry\b/.test(SIL_SRC)
  && /export function shelfLayout\b/.test(SIL_SRC)
  && /export function createPlateEl\b/.test(PLATE_SRC)
  && /_applyTier\(rec, n\)/.test(A0_SRC)
  && /updatePlate\(/.test(A0_SRC)

/** 三档实测几何体，测完一次给下面两个块共用（bbox 也已算好）。 */
const GEO = {}

/* ---------- 形状轴：某台机器怎么画，只有一个函数 ---------- */

{
  /* 只数**机器图元**。地面那块 CircleGeometry 与 GridHelper 是场景家具、不是"某台
     机器怎么画"，把它们一起算进来会让这条判据变成一个我必须绕开它才能通过的数。 */
  const MACHINE_GEO = /new THREE\.(?:Box|Cylinder|Sphere|Cone|Capsule|Torus|Lathe|Extrude|Shape|RoundedBox|Plane)Geometry\b/
  const inRenderer = hitsOf(A0_SRC, MACHINE_GEO)
  const control = hitsOf(SIL_SRC, MACHINE_GEO) + hitsOf(A1_SRC, MACHINE_GEO)
  if (!CODE_INTACT) bad('形状轴单点：渲染器不再为机器造几何体', '尺子失效——剥注释时把 lib 的函数头也剥掉了，这个 0 不是读数')
  else if (control === 0) bad('形状轴单点：渲染器不再为机器造几何体', `尺子失效——正对照（lib/silhouette.js ＋ A1）也零命中，这个 0 不是读数`)
  else if (inRenderer === 0) ok(`形状轴单点：A0 渲染器里机器图元 0 处（正对照同模式命中 ${control} 处＝工厂自己的 BoxGeometry ×${hitsOf(SIL_SRC, MACHINE_GEO)} ＋ 未动的 A1 ×${hitsOf(A1_SRC, MACHINE_GEO)}）—— 换某一档的形状只改 buildTierGeometry`)
  else bad('形状轴单点', `A0 渲染器里仍有 ${inRenderer} 处机器图元，形状还没有一个家`)
}

{
  /* 工厂的合同：机体底面在局部 y=0、总高等于**声明**高度（取景与标签锚点读的是声明
     值），地牌顶面也在局部 y=0（牌与机体之间不许有第二套座高）。合同不成立，"只改一
     个函数"就变成"改完还要去改渲染器"。
     容差 GEO_TOL 不是随手放的松：顶点存在 Float32Array 里，量到的是 GPU 那份顶点而不是
     JS 的双精度声明值，1e-9 会把 float32 的固有误差读成合同破了（实测 0.09 存成
     0.09000000357627869）。世界单位最大 3.4，1e-6 既盖得住 float32 的分辨率，又远小于
     任何看得出来的形变（墙上 1 世界单位 = 70.6px，1e-6 单位 = 0.00007px）。 */
  const GEO_TOL = 1e-6
  const near = (a, b) => Math.abs(a - b) < GEO_TOL
  const wrong = []
  const reads = []
  for (const k of TIERS) {
    const s = silhouetteSize(k)
    const { body, base } = buildTierGeometry(k)
    body.computeBoundingBox(); base.computeBoundingBox()
    GEO[k] = { body, base }
    const b = body.boundingBox, p = base.boundingBox
    const size = (box, ax) => box.max[ax] - box.min[ax]
    if (!near(b.min.y, 0)) wrong.push(`${k}.body 底面不在局部 y=0（yMin=${b.min.y}）`)
    if (!near(b.max.y, s.height)) wrong.push(`${k}.body 总高 ${b.max.y} ≠ 声明高 ${s.height}`)
    if (!near(size(b, 'x'), s.width) || !near(size(b, 'z'), s.depth)) wrong.push(`${k}.body 平面尺寸 ≠ silhouetteSize`)
    if (!near((b.min.x + b.max.x) / 2, 0) || !near((b.min.z + b.max.z) / 2, 0)) wrong.push(`${k}.body 未在 x/z 居中（席位会整体偏）`)
    if (!near(p.max.y, 0)) wrong.push(`${k}.base 顶面不在局部 y=0：牌与机体之间出现第二套座高`)
    if (!near(p.min.y, -SHELF.plinthThickness)) wrong.push(`${k}.base 厚 ${-p.min.y} ≠ plinthThickness ${SHELF.plinthThickness}`)
    const wantW = s.width + SHELF.plinthMargin * 2
    if (!near(size(p, 'x'), wantW) || !near(size(p, 'z'), s.depth + SHELF.plinthMargin * 2)) wrong.push(`${k}.base ≠ 机体 footprint ＋ 每侧 ${SHELF.plinthMargin}`)
    reads.push(`${k} 机体 ${size(b, 'x').toFixed(2)}×${size(b, 'y').toFixed(2)}×${size(b, 'z').toFixed(2)} y∈[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] 地牌 y∈[${p.min.y.toFixed(2)},${p.max.y.toFixed(2)}]`)
  }
  if (!wrong.length) ok(`buildTierGeometry 合同成立（三档，容差按 float32 顶点分辨率放 ${GEO_TOL}）：机体底面 y=0 且总高＝声明高、地牌顶面 y=0 且＝footprint＋每侧边 —— ${reads.join(' | ')}`)
  else bad('buildTierGeometry 的几何合同被破', wrong.join('; '))
}

{
  /* 两件配套的事：① 换局部原点必须是等价改动（世界摆放不能跟着动）；
     ② 工厂每次调用必须返回**新**几何体，因为 _applyTier 换档时 dispose() 旧的——
        若两档共用同一实例，一次换档会把另一台在用的模子从显存里释放掉。 */
  const wrong = []
  for (const k of TIERS) {
    const s = silhouetteSize(k)
    const { body, base } = GEO[k]
    // 渲染器把两件都坐在 -bodySeatY 上（见 _makeNode/_applyTier）
    const bodyTop = -SHELF.bodySeatY + body.boundingBox.max.y
    const baseBottom = -SHELF.bodySeatY + base.boundingBox.min.y
    if (Math.abs(bodyTop - (-SHELF.bodySeatY + s.height)) > 1e-6) wrong.push(`${k} 机体顶 ${bodyTop} ≠ 包 1 的读数 ${-SHELF.bodySeatY + s.height}`)
    if (Math.abs(baseBottom - (-SHELF.bodySeatY - SHELF.plinthThickness)) > 1e-6) wrong.push(`${k} 地牌底 ${baseBottom} ≠ 包 1 的读数 ${-SHELF.bodySeatY - SHELF.plinthThickness}`)
    if (Math.abs(-SHELF.bodySeatY + base.boundingBox.max.y + SHELF.bodySeatY) > 1e-6) wrong.push(`${k} 地牌顶与机体底之间有缝（两块会脱开）`)
  }
  if (buildTierGeometry('mini').body === buildTierGeometry('mini').body) wrong.push('工厂返回了同一实例：换档 dispose() 会放掉另一台在用的几何体')
  if (!wrong.length) ok(`形状轴重构是等价改动＋可安全释放：三档机体顶/地牌底的世界坐标与包 1 逐位相同，且每次调用返回新几何体（dispose 不会误伤邻格）`)
  else bad('形状轴重构不是等价改动', wrong.join('; '))
}

/* ---------- 排布轴：每排几格、折几排、格子落在哪，只有一个函数 ---------- */

{
  const probes = [[0, 1200], [1, 240], [3, 100], [4, 1920], [4, 959], [6, 960], [12, 1200]]
  const wrong = []
  for (const [count, width] of probes) {
    const seats = shelfLayout(count, width)
    const { cols, rows } = shelfGrid(count, width)
    if (seats.length !== count) wrong.push(`${count}@${width} 席位 ${seats.length} ≠ 台数`)
    seats.forEach((p, i) => {
      const x = ((i % cols) - (cols - 1) / 2) * SHELF.slotPitchWorld
      const y = SHELF.baseY + Math.floor(i / cols) * SHELF.rowPitchWorld
      if (Math.abs(p.x - x) > 1e-12 || Math.abs(p.y - y) > 1e-12) wrong.push(`${count}@${width} 第 ${i} 席 (${p.x},${p.y}) ≠ (${x},${y})`)
    })
    if (Math.max(1, Math.ceil(count / cols)) !== rows && count > 0) wrong.push(`${count}@${width} 排数与 shelfGrid 不一致`)
  }
  if (!wrong.length) ok(`shelfLayout 七点实测（含 0 台 / 窄容器退化 1 列）：坐标与包 1 的折行算式逐位相同 —— 抽函数是搬家不是改口径`)
  else bad('shelfLayout 与折行口径不一致', wrong.join('; '))
}

{
  /* 6 台 @ 960px → 4 列两排。钉的是包 1 的**列网格**口径：第 i 席永远站在第 i%cols 列
     上，末排不满时靠左 packed、不重新居中，所以上下排同列同 x、机体对齐成列。
     （这一条判据我第一版写反过：按"每排关于 0 居中"去要，那是逐排居中的读法，会把
     第二排两台往中间吸，和包 1 的算式对不上——上一块刚证明算式没改，所以错的是这条
     尺子。改法是把它写成真口径，并在下面留一条反例，让它真的能抓到逐排居中。） */
  const seats = shelfLayout(6, 960)
  const { cols } = shelfGrid(6, 960)
  const wrong = []
  const seen = new Set(seats.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`))
  if (seen.size !== seats.length) wrong.push('两个席位落在同一个位置（会叠成一台）')
  const colX = Array.from({ length: cols }, (_, c) => (c - (cols - 1) / 2) * SHELF.slotPitchWorld)
  seats.forEach((p, i) => {
    if (Math.abs(p.x - colX[i % cols]) > 1e-9) wrong.push(`第 ${i} 席 x=${p.x.toFixed(3)} 不在第 ${i % cols} 列位 ${colX[i % cols].toFixed(3)} 上（上下排不同列，机体互相错位）`)
  })
  const rows = [...new Set(seats.map((p) => p.y))].sort((a, b) => a - b)
  rows.forEach((y, r) => {
    const n = seats.filter((p) => p.y === y).length
    const want = r === rows.length - 1 ? seats.length - r * cols : cols
    if (n !== want) wrong.push(`第 ${r + 1} 排 ${n} 席，应为 ${want} 席（packed 顺序乱了）`)
  })
  for (const y of rows) {
    const row = seats.filter((p) => p.y === y).sort((a, b) => a.x - b.x)
    for (let i = 1; i < row.length; i += 1) {
      const gap = row[i].x - row[i - 1].x
      if (Math.abs(gap - SHELF.slotPitchWorld) > 1e-9) wrong.push(`邻席间距 ${gap} ≠ 槽距 ${SHELF.slotPitchWorld}`)
    }
  }
  for (let i = 1; i < rows.length; i += 1) {
    if (Math.abs((rows[i] - rows[i - 1]) - SHELF.rowPitchWorld) > 1e-9) wrong.push(`排间距 ${rows[i] - rows[i - 1]} ≠ 排距 ${SHELF.rowPitchWorld}`)
  }
  /* 整张网格的左右边界：最外列的列心 ± 半个槽口就是格子的边，最宽那档（rack，含地牌
     3.06）的外沿不许越过——这条是"槽口对谁都不改制"的可核对版本。 */
  const widestPlate = Math.max(...TIERS.map((k) => silhouetteSize(k).width + SHELF.plinthMargin * 2))
  const used = Math.max(...seats.map((p) => Math.abs(p.x))) + widestPlate / 2
  const gridHalf = (cols * SHELF.slotPitchWorld) / 2
  if (used > gridHalf + 1e-9) wrong.push(`最宽地牌外沿到 ${used.toFixed(2)} 世界单位 > 网格半宽 ${gridHalf.toFixed(2)}（出格）`)
  /* 反例：逐排居中长什么样，这里当场算一遍，确认本口径与它不同（相同就说明这条没牙）。 */
  const lastRow = seats.filter((p) => p.y === rows[rows.length - 1])
  if (lastRow.length < cols) {
    const perRowCentered = lastRow.map((_, c) => (c - (lastRow.length - 1) / 2) * SHELF.slotPitchWorld)
    if (lastRow.every((p, c) => Math.abs(p.x - perRowCentered[c]) < 1e-9)) wrong.push('末排被逐排居中了：与包 1 的列网格口径不符，上下排不再对齐')
  }
  if (!wrong.length) ok(`排布不变量（6 台@960 实测 ${cols} 列 ${rows.length} 排）：席位互不相同 · 每席踩在自己的列位上（末排靠左 packed，不逐排居中）· 邻席恰为一个槽距 · 排间距恰为一个排距 · 最宽地牌外沿 ${used.toFixed(2)} ≤ 网格半宽 ${gridHalf.toFixed(2)}`)
  else bad('排布不变量被破', wrong.join('; '))
}

{
  const COORD = /slotPitchWorld|rowPitchWorld|% cols|Math\.floor\(i \/ /
  const inRenderer = hitsOf(A0_SRC, COORD)
  const control = hitsOf(SIL_SRC, COORD)
  if (!CODE_INTACT) bad('排布轴单点：渲染器不再算格子坐标', '尺子失效——剥注释把 lib 的函数头也剥掉了')
  else if (control === 0) bad('排布轴单点：渲染器不再算格子坐标', '尺子失效——正对照（lib/silhouette.js）也零命中')
  else if (inRenderer === 0) ok(`排布轴单点：A0 渲染器里坐标算式 0 处（正对照同模式在 lib/silhouette.js 命中 ${control} 处）—— 改折行/槽距/排距只改 shelfLayout`)
  else bad('排布轴单点', `A0 渲染器里还有 ${inRenderer} 处坐标算式：${(A0_SRC.match(new RegExp(COORD.source, 'g')) || []).join(' / ')}`)
}

/* ---------- 牌面轴：这一格写什么字、字怎么排，只有一个模块 ---------- */

{
  /* 牌面模板与选择器都不该在渲染器里。对照物用的是**没被本轮碰过**的 A1：同一条模式
     在它身上必须命中，否则这条"0"是探针坏了。 */
  const PLATE_HTML = /innerHTML|<div\s+class|\.tl-name|\.tl-sub|querySelector/
  const inRenderer = hitsOf(A0_SRC, PLATE_HTML)
  const control = hitsOf(A1_SRC, PLATE_HTML)
  const plateOwns = hitsOf(PLATE_SRC, PLATE_HTML)
  if (!CODE_INTACT) bad('牌面轴单点：渲染器不再出现牌面 HTML/选择器', '尺子失效——剥注释把 plate.js 的函数头也剥掉了')
  else if (control === 0) bad('牌面轴单点：渲染器不再出现牌面 HTML/选择器', '尺子失效——正对照（A1 TopologyRenderer.js）也零命中')
  else if (inRenderer !== 0) bad('牌面轴单点', `A0 渲染器里还有 ${inRenderer} 处牌面模板/选择器：${(A0_SRC.match(new RegExp(PLATE_HTML.source, 'g')) || []).join(' / ')}`)
  else if (plateOwns === 0) bad('牌面轴单点', 'lib/plate.js 也没有牌面结构了？牌面没有家了')
  else ok(`牌面轴单点：A0 渲染器 0 处牌面 HTML／选择器（正对照 A1 命中 ${control} 处，牌面的家 lib/plate.js 命中 ${plateOwns} 处）`)
}

{
  /* 牌面不许自带样式：色值只能有 palette.js / :root 两个家，DOM 侧再写一支就是
     H9 那个形状。对照＝palette.js 自己（本脚本另一处已经用它验过同族判据）。 */
  const COLOR = /#[0-9a-fA-F]{3,8}\b|0x[0-9a-fA-F]{6}\b|rgba?\(/
  const inPlate = hitsOf(PLATE_SRC, COLOR)
  const inlineStyle = hitsOf(PLATE_SRC, /\.style\.[a-zA-Z]/)
  const control = hitsOf(readSrc('lib/palette.js'), COLOR)
  if (!CODE_INTACT) bad('牌面零色值缺正对照', '尺子失效——剥注释把 plate.js 的函数头也剥掉了')
  else if (control < 20) bad('牌面零色值缺正对照', `palette.js 只量到 ${control} 支，这条尺子不算数`)
  else if (inPlate || inlineStyle) bad('牌面自带样式了', `色值 ${inPlate} 处、内联 style ${inlineStyle} 处——牌面只管结构，样式在 style.css`)
  else ok(`牌面轴只管结构：lib/plate.js 色值 0 支、内联 style 0 处（正对照：同一条正则从 palette.js 量到 ${control} 支）`)
}

{
  /* 截断只许有一处口径：topology-vm.js 调 status.js 的 shortName（§1.3 节点名 ≤8 字）。
     牌面里再写一套 slice/省略号，墙上和场景就会对同一台机器给出两个名字。 */
  const TRUNC = /\.slice\(|\.substring\(|padEnd|…/
  const inPlate = hitsOf(PLATE_SRC, TRUNC)
  const control = hitsOf(STATUS_SRC, TRUNC)
  if (!CODE_INTACT) bad('截断只有一个家缺正对照', '尺子失效——剥注释把 plate.js 的函数头也剥掉了')
  else if (control === 0) bad('牌面不再自截断缺正对照', 'status.js 里量不到截断写法，这条尺子不算数')
  else if (inPlate) bad('牌面里出现第二套截断', `命中 ${inPlate} 处——截断的口径在 status.js 的 shortName，由 topology-vm 应用`)
  else ok(`截断只有一个家：lib/plate.js 0 处截断写法（正对照：status.js 的 shortName 命中 ${control} 处），牌面只写送进来的名字`)
}

{
  /* 小字文案 = 诚实性文案，照字保留（不许润色成更好听的说法）。这里钉的是**字面**，
     不是"语义相近"：在场且活着的机器没有状态句，所以空串是正确读数而不是待填的坑。 */
  const cases = [
    [{ absent: true, online: false }, '离场（临时节点，不报警）', 'absent 赢 online：临时节点离开不是失联'],
    [{ absent: false, online: false }, '失联', '常驻节点不再上报'],
    [{ absent: false, online: true }, '', '在场的机器牌面上没有第二句状态（状态由机体色相说）'],
    [{}, '失联', '字段缺失时按不在场说，不猜"正常"'],
  ]
  const wrong = []
  for (const [rec, want, why] of cases) {
    const got = plateSub(rec)
    if (got !== want) wrong.push(`${JSON.stringify(rec)} → 「${got}」，应为「${want}」（${why}）`)
  }
  if (!wrong.length) ok(`牌面小字三句口径逐字钉住（含空串那一格），且 absent 优先于 online：${cases.map((c) => `「${c[1] || '∅'}」`).join(' / ')}`)
  else bad('牌面文案被改了', wrong.join('; '))
}

/* ==========================================================================
   V3 包 2 步 2 · 牌面排版的边界
   --------------------------------------------------------------------------
   步 2 只改版式（style.css 的 `.topo-host` 那一族 ＋ KioskView 那三条 `[data-kiosk]
   .topo-label` 之一），所以这里量的全是"排版有没有越界"：
     - 越到 A1 的芯片标签上（详情页本轮一行不碰）；
     - 越到第二个家（同一份间距在 kiosk 那份里再写一遍）；
     - 越到颜色／字号／图形上（本轮不许自创色值、不许新增一档字号、不许发明识别特征）。
   全部从 CSS 源文算，不用浏览器；读法一律先剥注释，再按 `selector { body }` 切块。
   每条「零命中」都带同一条模式的正对照（色表纪律 R-6）。
   ========================================================================== */

const stripCss = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
const cssRules = (text) => [...stripCss(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
  .filter((r) => !r.sel.startsWith('@'))
const plateRulesOf = (rules) => rules.filter((r) => /\.tl-(name|sub)|\.topo-label|\.topo-host/.test(r.sel))
/** 只在**牌面族**的选择器里找带某属性的规则（分块间距／装饰／字号各一条判据共用）。 */
const plateDeclaring = (rules, prop) => rules.filter((r) => new RegExp(prop).test(r.body))

const STYLE_CSS = readSrc('style.css')
const KIOSK_VUE = readSrc('views/KioskView.vue')
const STYLE_PLATE = plateRulesOf(cssRules(STYLE_CSS))
const KIOSK_PLATE = plateRulesOf(cssRules(KIOSK_VUE))
const PLATE_RULES = STYLE_PLATE.concat(KIOSK_PLATE)

{
  /* 「机名与状态一眼分开」= 两块之间有一条边界。边界只许由 `.topo-host` 那一条画：
     基规则 `.topo-label .tl-sub` 是 A0 与 A1 共用的，往它身上加间距就改了详情页。 */
  const SPLIT = /margin-top|padding-top|border-top/
  const splitters = plateDeclaring(STYLE_PLATE, SPLIT.source)
  /* 判法不是"基规则里不许出现 margin-top"——`.topo-label .tl-sub{margin-top:2px}` 是
     A1 芯片标签的现值，本轮一行不碰详情页，删它就等于改了 A1 的行距。判的是**机体牌
     身上这一格谁说了算**：非 `.topo-host` 规则声明的每一个分块属性，都必须被某条
     `.topo-host` 规则同名覆盖（`.topo-label.topo-host .tl-sub` 特异性 0,3,0 >
     `.topo-label .tl-sub` 0,2,0，且写在它后面），否则 A0 的版式就有第二个家。 */
  const leaf = (sel) => (sel.match(/\.tl-(?:name|sub)/) || ['(整块牌面)'])[0]
  const splitProps = (body) => [...body.matchAll(/\b(margin-top|padding-top|border-top)\b/g)].map((m) => m[1])
  const ownership = {}
  for (const r of STYLE_PLATE) {
    const props = splitProps(r.body)
    if (!props.length) continue
    const k = leaf(r.sel)
    const slot = (ownership[k] ||= { host: new Set(), other: new Set() })
    slot[r.sel.includes('topo-host') ? 'host' : 'other'].add(...props)
  }
  const uncovered = Object.entries(ownership)
    .flatMap(([k, v]) => [...v.other].filter((p) => !v.host.has(p)).map((p) => `${k}{${p}}`))
  const control = plateDeclaring(cssRules(STYLE_CSS), SPLIT.source).length
  if (control === 0) bad('分块规则不越界到 A1', '尺子失效——整个 style.css 里量不到任何 margin/padding/border-top 声明')
  else if (uncovered.length) bad('分块规则不越界到 A1', `机体牌上这些分块属性仍由共用规则说了算：${uncovered.join(' / ')}——要么收进 .topo-host，要么被同名覆盖`)
  else if (!splitters.some((r) => /border-top/.test(r.body))) bad('机名与状态没有真的分开', '牌面族里找不到一条 border-top——只有空没有线，两块还是会被读成一行')
  else ok(`分块规则不越界到 A1：${Object.keys(ownership).length} 个牌面块（${Object.keys(ownership).join(' / ')}）的分块属性全部由 .topo-host 说了算——被同名覆盖的共用声明：${Object.entries(ownership).flatMap(([k, v]) => [...v.other].map((p) => `${k}{${p}}`)).join(' / ') || '无'}（A1 的现值因此没被删，只是不再管机体牌）（正对照：同一条模式在 style.css 全文命中 ${control} 条，含 .en-codelist／.k-bottom 这些既有分块），且分隔线确实画了一条 1px var(--border)`)
}

{
  /* 版式只有一个家：kiosk 那份 `[data-kiosk] .topo-label` 从步 2 起只管字号与外框，
     机名块/状态块之间的空回到 style.css 那一条（用 em 跟着字走）。
     这里数的是**分块间距**，不是外框 padding：`padding: 6px 14px` 是牌子自己的外框，
     墙上要厚一点是它的事，与"两块怎么分开"不是同一个事实。 */
  const kioskPlate = KIOSK_PLATE
  const dup = kioskPlate.filter((r) => /margin-top|padding-top|border-top/.test(r.body))
  const control = kioskPlate.filter((r) => /font-size/.test(r.body)).length
  if (control === 0) bad('牌面间距只有一个家', '尺子失效——KioskView 里量不到任何牌面字号规则，那这条"没有间距"什么也没说')
  else if (dup.length) bad('牌面间距只有一个家', `kiosk 那份又写了分块间距：${dup.map((r) => `${r.sel}{${r.body.trim()}}`).join(' / ')}`)
  else ok(`牌面间距只有一个家：KioskView 的牌面规则 ${kioskPlate.length} 条里 0 条分块间距（正对照：同族规则里有 ${control} 条在写字号，说明这条尺子看得见这个块）`)
}

{
  /* 两条"不许"一起量：本轮不上字体文件、也不新增一档字号；色值只许走 token。
     字号那半边是个**集合**判据——沿用动手前那四档（style.css 11/9 ＋ kiosk 20/15），
     多出来的任何一档都会让它 FAIL，因为 `:root` 里根本没有字号 token 可以收（已核）。 */
  const SIZES_BEFORE = ['11px', '15px', '20px', '9px']       // 包 2 步 2 动手前从 HEAD 量的四档
  const sizes = [...new Set(PLATE_RULES.flatMap((r) => [...r.body.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim())))].sort()
  const COLOR = /#[0-9a-fA-F]{3,8}\b|0x[0-9a-fA-F]{6}\b|rgba?\(/
  const literals = PLATE_RULES.filter((r) => COLOR.test(r.body)).map((r) => r.sel)
  const control = new Set([...stripCss(STYLE_CSS).matchAll(/font-size:\s*[^;}]+/g)].map((m) => m[0])).size
  const cssSizes = hitsOf(stripCss(STYLE_CSS), /font-size:/)
  const kioskSizes = hitsOf(stripCss(KIOSK_VUE), /font-size:/)
  const wrong = []
  if (cssSizes === 0 || kioskSizes === 0) bad('牌面不新增字号档缺正对照', `同一条模式在 style.css 量到 ${cssSizes} 条、KioskView 量到 ${kioskSizes} 条字号声明——有一边是瞎的，这个集合读数不算数`)
  else if (control < 4) bad('牌面不新增字号档缺正对照', `style.css 全文只量到 ${control} 档字号，牌面却报了 ${sizes.length} 档——这条尺子不算数`)
  else if (sizes.join(' ') !== SIZES_BEFORE.join(' ')) wrong.push(`字号集合从「${SIZES_BEFORE.join(' / ')}」变成「${sizes.join(' / ')}」——本轮不许自己造一档（要新 token 得停下来报告）`)
  if (literals.length) wrong.push(`牌面规则里出现自创色值：${literals.join(' / ')}`)
  if (!wrong.length) ok(`牌面不加字号档、不自创色值：牌面族 ${PLATE_RULES.length} 条规则的字号集合仍是 ${sizes.join(' / ')}（正对照：同一条模式在 style.css 命中 ${cssSizes} 条字号声明、KioskView ${kioskSizes} 条，全文 ${control} 档），色值全部走 var(--…)`)
  else bad('步 2 越界了', wrong.join('; '))
}

{
  /* §7.2：站姿 + 高宽比 + 大小是档间唯一区别，牌面不许发明第四个识别特征——
     落到 CSS 上就是：不加图形（content/url/渐变/阴影/伪元素/圆点）。 */
  const DECOR = /content:|url\(|background-image|linear-gradient|radial-gradient|box-shadow|::before|::after|border-radius:\s*50%/
  const decorated = PLATE_RULES.filter((r) => DECOR.test(r.body)).map((r) => r.sel)
  const control = hitsOf(readSrc('components/HostCard.vue'), DECOR) + hitsOf(stripCss(STYLE_CSS), DECOR)
  if (control === 0) bad('牌面不发明识别特征', '尺子失效——同一条模式在仓库里一处也量不到，这个 0 不是读数')
  else if (decorated.length) bad('牌面发明识别特征了', `${decorated.join(' / ')} 里出现图形／装饰声明：图标、灯点、渐变这一类`)
  else ok(`牌面不发明识别特征：${PLATE_RULES.length} 条牌面规则 0 处图形声明（正对照：同一条模式在 HostCard.vue ＋ style.css 命中 ${control} 处）——分开两块靠的是空与线，不是新符号`)
}

{
  /* 诚实文案的字面只许有一个家：那句「离场（临时节点，不报警）」如果被 CSS 用
     `content:` 再抄一份，改文案的人就会只找到一处、发出去两份。 */
  const SENTENCE = '离场（临时节点，不报警）'
  const inCss = hitsOf(stripCss(STYLE_CSS), new RegExp(SENTENCE)) + hitsOf(stripCss(KIOSK_VUE), new RegExp(SENTENCE))
  const inRenderer = hitsOf(readCode('three/ClusterTopologyRenderer.js'), new RegExp(SENTENCE))
  const control = readSrc('lib/plate.js').includes(SENTENCE)
  if (!control) bad('文案只有一个家', 'lib/plate.js 里反而没有这句话了——牌面小字没了家')
  else if (inCss || inRenderer) bad('文案只有一个家', `牌面小字被抄进样式（${inCss} 处）或渲染器（${inRenderer} 处），改一处会漏另一处`)
  else ok(`文案只有一个家：「${SENTENCE}」在 style.css／KioskView／A0 渲染器 0 处（正对照：lib/plate.js 有这一支，且本脚本上面那条判据正从它身上读值）`)
}

/* ==========================================================================
   V3 包 2 步 3 · A0 无面板变体 —— **本步已于 09-22 深夜撤回**
   --------------------------------------------------------------------------
   撤回归档，不是删掉：这一步当时唯一的非审美理由是"每帧重采样＝钱"，而那个理由被实测
   否掉了（标签页可见时，4 张牌在 none／blur(4px)／blur(20px) 三态各测一批，全部
   16.7ms、共约 590 帧零掉帧 ⇒ 半径放大 5 倍也吃不到一帧的余量）。所以画面回到基规则
   那份 blur，牌面身上不许再出现任何 `backdrop-filter` 声明——**这条判据现在防的是
   "有人不带着墙机读数又把 blur 撤一遍"**（`KioskView.vue` 那条禁则说的是整屏面积）。
   ========================================================================== */

{
  const base = cssRules(STYLE_CSS).find((r) => r.sel === '.topo-label')
  const host = plateRulesOf(cssRules(STYLE_CSS)).filter((r) => r.sel.includes('topo-host'))
  const still = hitsOf(stripCss(STYLE_CSS), /backdrop-filter:\s*blur\(/)
  const onHost = host.filter((r) => /backdrop-filter/.test(r.body))
  if (!base) bad('A0 机体牌沿用基规则的 blur', '尺子失效——style.css 里读不到 `.topo-label` 那条基规则，下面什么都判不了')
  else if (!/backdrop-filter:\s*blur\(/.test(base.body)) bad('A1 的标签被碰了', '`.topo-label` 基规则里的 blur 不见了——详情页本轮一行不碰，A1 的芯片标签读的就是这一份')
  else if (onHost.length) bad('A0 机体牌沿用基规则的 blur', `牌面身上又出现了 backdrop-filter 声明：${onHost.map((r) => `${r.sel}{${r.body.trim()}}`).join(' / ')}——步 3 已撤回，要再撤得先带墙机上的帧率读数`)
  else ok(`A0 机体牌沿用基规则那份 blur(4px)：.topo-host 族 ${host.length} 条规则里 backdrop-filter 0 处，覆盖已撤（正对照：基规则仍在，全文件仍有 ${still} 处 backdrop-filter: blur()，一处也数不清＝尺子瞎了）`)
}

{
  /* 逐处点名：仍然写 blur 的选择器必须**恰好**是这三条，并且每一条都说得出它在哪个屏上。
     任务书给的行号（:96/:136/:152）与仓库现值（:139/:185/:216）已经漂开，所以这里
     钉的是"谁在用"，不是"在第几行"。 */
  const blurSites = cssRules(STYLE_CSS).filter((r) => /backdrop-filter:\s*blur\(/.test(r.body)).map((r) => r.sel).sort()
  const WANT = ['.bus-legend', '.metrics-hud', '.topo-label']
  const consumersOf = (cls, files) => files.filter((f) => readSrc(f).includes(cls)).map((f) => f.replace(/\.vue$|\.js$/, ''))
  const A0_FILES = ['views/KioskView.vue', 'views/TopologyView.vue', 'three/ClusterTopologyRenderer.js', 'lib/plate.js']
  const ALL_FILES = A0_FILES.concat(['views/DetailView.vue', 'three/TopologyRenderer.js', 'components/HudPanel.vue'])
  const owners = {
    '.bus-legend': consumersOf('bus-legend', ALL_FILES),
    '.metrics-hud': consumersOf('metrics-hud', ALL_FILES),
    '.topo-label': consumersOf('topo-label', ALL_FILES),
  }
  const wrong = []
  if (blurSites.join(' ') !== WANT.join(' ')) wrong.push(`还在写 blur 的选择器不是这三条：实际「${blurSites.join(' / ')}」，应为「${WANT.join(' / ')}」`)
  if (!owners['.bus-legend'].includes('views/DetailView')) wrong.push(`.bus-legend 的主人读不到 DetailView（实测 ${owners['.bus-legend'].join('/') || '无消费方'}）——那一处 blur 属于 A1 还是别处，说不清`)
  const plateOwners = owners['.topo-label']
  if (!plateOwners.some((f) => ['lib/plate', 'three/ClusterTopologyRenderer', 'views/KioskView', 'views/TopologyView'].includes(f))) wrong.push(`.topo-label 在 A0 侧读不到消费方（实测 ${plateOwners.join('/') || '无'}），那它身上这层 blur 留着就没有"A1 共用"这个理由了`)
  if (owners['.metrics-hud'].length) wrong.push(`.metrics-hud 已有消费方（${owners['.metrics-hud'].join(' / ')}），那它就不是死规则，步 3 该把它也算进 A0 的账`)
  const control = consumersOf('hud-row', ALL_FILES)
  if (!control.length) bad('每一处 blur 都有主人', '尺子失效——同一条扫描在仓库里读不到 .hud-row 这个必然存在的类，那个"metrics-hud 0 消费方"不算读数')
  else if (!wrong.length) ok(`每一处 blur 都有主人：${WANT.map((s) => `${s}→${owners[s].join('/') || '（0 消费方＝死规则，登记不删）'}`).join(' | ')}（正对照：同一条扫描在 ${control.join('/')} 读得到 .hud-row）`)
  else bad('每一处 blur 都有主人', wrong.join('; '))
}

/* ==========================================================================
   V3 包 4 步 2 · 档名的取值顺序：声明优先，猜测降为回落（任务书 §5.5 步 2）
   --------------------------------------------------------------------------
   上面那一条"档名纯函数 silhouetteTierOf(record)：7 例全命中"是**包 1 的临时家**
   留下的判据，本块**只追加**、没动它一根手指（色表纪律 R-6 ＋ §6"永不重写"第 2 条）。

   这一块要买的不是"函数还能跑"，而是一条方向：**声明能不能压过猜测**。
   所以每条判据都配一个反方向的对照——同一台机器把声明撤掉必须回到原来的读数，
   否则"声明命中即用"可能只是"猜对了"的另一种写法（永真式）。
   ========================================================================== */

{
  /* ① 声明命中即用：三档各自声明、名字故意留空，读数必须来自声明而不是默认档。
        （名字留空是关键：全给空名的话 mini 那一档就成了"回落也恰好对"的假读数。） */
  const declared = [['laptop', '', ''], ['mini', '', ''], ['rack', '', '']]
  const wrong = declared.filter(([tier]) => silhouetteTierOf({ id: 'zz', name: '', form_factor: tier }) !== tier)
  if (!wrong.length) ok(`包 4 声明优先：三档逐个声明（名字全空）都按声明走（${declared.map(([t]) => t).join('/')}）`)
  else bad('声明没被读到', `这些档声明后读不回来：${wrong.map(([t]) => t).join(', ')}`)
}

{
  /* ② 派单点名的**关键正对照**：display_name 里写着"笔记本"、声明却是 rack。
        这条不通就说明猜测路径还在压过声明——而它在墙上是看不出来的，因为名字里
        带形态词的机器恰好只有一两台。
        对照（同一台机器、只撤掉声明）必须回到 laptop：证明名字确实在被猜，
        上面那个 rack 是声明挣来的，不是蒙的。 */
  const rec = { id: 'sim-notebook', name: '模拟-笔记本道具', form_factor: 'rack' }
  const got = silhouetteTierOf(rec)
  const without = silhouetteTierOf({ id: rec.id, name: rec.name })
  if (got === 'rack' && without === 'laptop') {
    ok(`声明压过名字（关键正对照）：「${rec.name}」声明 rack → ${got}；同机撤掉声明 → ${without}（猜测路径仍在，只是降了一级）`)
  } else bad('声明与猜测的先后顺序不对', `声明时 ${got}（应 rack）、撤声明 ${without}（应 laptop）`)
}

{
  /* ③ 无声明时逐例回落，且**与包 4 之前的读数一字不差**。
        host_id 是真名（demo.js 的 SCENARIO 与 probes.json 的 infer-142），
        display_name 取任务书 §2 假快照的命名法（srv-231 那条用 'mini-231'）。
        这一条是"改顺序不能顺手改结果"的闸：任何一台机器今天画成什么，
        没声明的人就得继续画成什么。 */
  const TODAY = [
    ['sim-notebook', '模拟-笔记本道具', 'laptop'],
    ['sim-vectordb', '模拟-向量库机', 'mini'],
    ['sim-tmpnote', '模拟-临时笔记本', 'laptop'],
    ['infer-142', 'ryzen5600-142', 'rack'],
    ['srv-231', 'mini-231', 'mini'],
  ]
  const drift = []
  for (const [id, name, want] of TODAY) {
    for (const [label, ff] of [['null', null], ['空串', ''], ['未带这个键', undefined]]) {
      const got = silhouetteTierOf({ id, name, ...(ff === undefined ? {} : { form_factor: ff }) })
      if (got !== want) drift.push(`${id} 声明=${label} → ${got}，应为 ${want}`)
    }
  }
  if (!drift.length) ok(`无声明回落与今天逐例相同：${TODAY.length} 台 × 3 种"没声明"的写法（null／空串／键不存在）共 ${TODAY.length * 3} 读全等`)
  else bad('回落结果漂了', drift.join('; '))
}

{
  /* ④ 不认识的值不算"第四档"：它算"这条声明我们读不懂"，落回**猜测**而不是落回默认档。
        一台名字写着"机架"而值填成 rack-2u 的机器，猜成 rack 是对的、静悄悄画成微型方盒
        是错的（H34 那一族：错了没人报错）。对照：值拼错且名字里没形态词 → 才落默认档。 */
  const typo = silhouetteTierOf({ id: 'x99-rack', name: 'X99 机架', form_factor: 'rack-2u' })
  const typoNoHint = silhouetteTierOf({ id: 'odd-box', name: 'OddBox', form_factor: 'tower' })
  const allKeys = Object.keys(SILHOUETTE_TIERS)
  if (typo === 'rack' && allKeys.includes(typoNoHint) && typoNoHint === SILHOUETTE_DEFAULT) {
    ok(`读不懂的声明落回猜测不落回默认档：'rack-2u'+名字含"机架" → ${typo}；'tower'+无名 → ${typoNoHint}（默认档），且返回值永远是已知的三档之一`)
  } else bad('未知声明值的处置不对', `rack-2u → ${typo}（应 rack）、tower → ${typoNoHint}（应 ${SILHOUETTE_DEFAULT}）`)
}

{
  /* ⑤ 值域没有第四档，也不是服务端能造出来的：SILHOUETTE_TIERS 的键集合仍是三档。
        （派单硬约束："不许发明第四档、不许改任何几何参数"——几何参数由上面
        "三档两两分得开"那组判据守着，这里只钉"档数"。） */
  const keys = Object.keys(SILHOUETTE_TIERS).sort()
  if (keys.join(',') === 'laptop,mini,rack') ok(`形态档仍是三档、没有第四档：${keys.join(' / ')}`)
  else bad('档数变了（本包无权改）', `实际 ${keys.join(', ')}`)
}

{
  /* ⑥ 声明这条路不许被原型链污染：'constructor'/'__proto__'/'toString' 不是档名。
        判法用 Object.hasOwn 而不是 `in`——`'constructor' in {}` 为真，那样一个乱填的
        值会拿到"看起来合法"的一档。对照：同一条判法必须仍认三个真档名。 */
  const polluted = ['constructor', '__proto__', 'toString', 'hasOwnProperty']
  const leaked = polluted.filter((v) => !Object.keys(SILHOUETTE_TIERS).includes(silhouetteTierOf({ id: 'plain-box', name: 'PlainBox', form_factor: v })))
  const real = ['laptop', 'mini', 'rack'].every((t) => silhouetteTierOf({ id: 'plain-box', name: 'PlainBox', form_factor: t }) === t)
  if (!leaked.length && real) ok(`声明读法不吃原型链：${polluted.join('/')} 全部落回猜测（正对照：三个真档名照常命中，且真档名用 hasOwn 判）`)
  else bad('声明读法被原型链污染', `这些值当成了档名：${leaked.join(', ')}`)
}

{
  /* ⑦ 规范化：服务端 setProfile 已把值 trim + 小写，但客户端不依赖它——
        这一列还可能由 SQL 直接写、由旧版服务端送来。 */
  const got = silhouetteTierOf({ id: 'a', name: 'zz', form_factor: ' RACK ' })
  if (got === 'rack') ok('声明按 trim＋小写规范化后命中（\' RACK \' → rack）：不依赖服务端已清洗')
  else bad('声明未规范化', `' RACK ' → ${got}`)
}

/* ⑨ 两屏同源（派单步 2 的"?kiosk 与桌面两条路都跑一次档名"）。
   静态稿阶段跑不了浏览器，所以这一条量的不是"我看过了"，而是**那条路只有一个家**：
   两条路都得经过 topologyViewModel → ClusterTopologyRenderer → silhouetteTierOf，
   并且客户端没有第二处自己判档。谁另起一判，两屏就会在"这台是什么形态"上分家——
   正是 S4 §2.2 立 topologyViewModel 时要杀的那个形状。 */
{
  const callsVm = (rel) => /topologyViewModel\(/.test(readSrc(rel))
  const consumers = ['three/ClusterTopologyRenderer.js', 'three/TopologyRenderer.js', 'views/KioskView.vue',
    'views/TopologyView.vue', 'views/DetailView.vue', 'lib/plate.js', 'lib/status.js']
    .filter((f) => /silhouetteTierOf\s*\(/.test(readSrc(f)))
  const tierWords = ['three/TopologyRenderer.js', 'views/DetailView.vue']
    .filter((f) => /TIER_HINTS|'笔记本'|"笔记本"|'机架'|"机架"/.test(readSrc(f)))
  const okPath = callsVm('views/TopologyView.vue') && callsVm('views/KioskView.vue')
  if (okPath && consumers.join(',') === 'three/ClusterTopologyRenderer.js') {
    ok(`两屏同源：桌面(A0)与 ?kiosk 都调 topologyViewModel → 档名只有 ClusterTopologyRenderer 一处消费者`
      + `（正对照：同一条扫描在 ${consumers.length} 处命中；第二判法 0 处）`)
  } else bad('档名不再只有一个家', `桌面走 vm=${callsVm('views/TopologyView.vue')}、kiosk 走 vm=${callsVm('views/KioskView.vue')}、消费者=${consumers.join('/') || '无'}`)
  if (tierWords.length) bad('A1 侧自己长出了形态判法', `${tierWords.join(', ')} 里读到形态关键词字面量，两屏会分家`)
  else ok(`A1 与牌面侧 0 处第二判法（正对照：形态关键词只存在于 lib/silhouette.js 的那张回落表里）`)
}

/* ⑧ 声明到得了 A0 吗？—— 从"登记"升成"判据"（他 09-22 深夜裁"接这一行"）
   silhouetteTierOf 读的是 topologyViewModel 造出来的那条记录，而这条记录是一个
   **字段白名单**。服务端那一列经 store.js 的档案族挂到每个 host 上（步 1 的 H5 钉着），
   再经这一行进白名单，档名才第一次由**他的声明**决定而不是由机名猜。
   为什么这一条必须钉死而不是"看一眼就好"：白名单少一个字段时**什么都不会坏**——
   渲染器拿到 undefined 就落回猜测表，墙上照样有形状、照样没有报错，只有"你声明过"
   这件事无声消失了。这与 H34"看着像旋钮、其实没接线"同形。 */
{
  const VM = readSrc('lib/topology-vm.js')
  /* `[^
]*` 而不是直接跟 `h\.x`：那一族里写的是 `online: !!h.online`，中间有 `!!`。
     第一版按 `online:\s*h\.online` 扫，对照读到 0 处＝尺子瞎了，那个 form_factor
     的 0 就不能算读数（R-6 当场自证了一次）。 */
  const fwd = (name) => [...VM.matchAll(new RegExp(`^\\s*${name}:\\s*[^\\n]*\\bh\\.${name}(?![\\w])`, 'gm'))].length
  const ctrl = fwd('online')
  const got = fwd('form_factor')
  if (!ctrl) bad('白名单转发扫描缺正对照', `同一条扫描读不到同族的 online 转发 ⇒ "form_factor ${got} 处"不算读数，尺子瞎了`)
  else if (got !== 1) bad('声明接不进 A0：topology-vm 白名单少了这一行', `读到 ${got} 处（应为 1）。正对照 online=${ctrl} 处，所以这不是扫描器的问题——墙上档名会退回按机名猜`)
  else ok(`声明走完了整条链路：roster 列 → store 转发（H5）→ topology-vm 白名单 1 处（正对照：同一条扫描读到同族 online 转发 ${ctrl} 处）`
    + ` ⇒ 两屏（桌面 A0 与 ?kiosk）共用这一份映射，一处接线两屏同时生效`)
}

/* ==========================================================================
   V3 包 4 步 3 · A1 的负载色收进唯一色源，但**收编不等于并道**（任务书 §5.5 步 3）
   --------------------------------------------------------------------------
   `_loadColor` 那四支表达**忙不忙**，`palette.STATE` 那四支表达**好不好**。V3 的第一
   通道规则是"亮度＝负载、色相＝状态两维独立"，所以这一族必须有自己的键。
   下面每一条都配了派单点名的那条正对照：**同一条尺子必须仍然扫得到 PCB／铜／金
   那族装饰色**——扫不到就是尺子瞎了，那时的"0 处字面量"不算读数。
   ========================================================================== */

{
  const A1 = readSrc('three/TopologyRenderer.js')
  const HEXLIT = /0x[0-9a-fA-F]{6}/g
  const total = [...A1.matchAll(HEXLIT)].length
  const body = /  _loadColor\(percent\) \{([\s\S]*?)\n  \}/.exec(A1)
  if (!body) { bad('读不到 _loadColor 函数体', '形状变了，下面几条全部作废重判') }
  else {
    const inBody = [...body[1].matchAll(HEXLIT)].length
    const moved = [...body[1].matchAll(/\bLOAD\.(\w+)/g)].length
    const MOVED_AS_DISPATCHED = 5   // 0x455a64 ×1 + 0x4caf50 ×1 + 0xff9800 ×2 + 0xf44336 ×1，派单【落笔前事实】那一段
    const BASELINE = 56     // 包 4 动手之前同一条正则在同一文件的读数
    const deco = ['0x1b7a1b', '0xb87333', '0xffd700']
      .map((h) => ({ h, n: [...A1.matchAll(new RegExp(h, 'g'))].length }))
    /* 正对照先判，再允许它报"零"（R-6 的顺序）：装饰色扫不到 ⇒ 函数体那个 0 不是读数。 */
    if (deco.some((d) => d.n === 0)) {
      bad('负载色扫描缺正对照', `同一条尺子在 A1 里读不到装饰色 ${deco.filter((d) => d.n === 0).map((d) => d.h).join(', ')} ⇒ 函数体那个"0 处"不算读数，尺子瞎了`)
    } else if (inBody !== 0) {
      bad('_loadColor 里仍有表外色值', `函数体内还有 ${inBody} 支 0x 字面量；颜色只有 palette.js / :root 两个家`)
    } else if (total !== BASELINE - MOVED_AS_DISPATCHED || moved !== MOVED_AS_DISPATCHED) {
      bad('收编的账不平', `全文件 ${BASELINE} → ${total}（降 ${BASELINE - total}），但函数体内 LOAD.* 引用 ${moved} 次、派单登记搬走 ${MOVED_AS_DISPATCHED} 支 ⇒ **下降数必须等于搬走数**，否则要么有人往里塞了新字面量，要么把不相干的色一起搬走了`)
    } else {
      ok(`A1 负载色收编：_loadColor 函数体 0 支字面量、走 LOAD.* ${moved} 次；全文件 0x 计数 ${BASELINE}→${total}（降 ${BASELINE - total}＝搬走数）`
        + `（正对照：同一条尺子仍扫到未收编的装饰色 PCB ${deco[0].n}／铜 ${deco[1].n}／金 ${deco[2].n} 支——本轮不收编，它们不表达事实）`)
    }
    /* 三个调用点是授权范围的另一半，本包**没有**改它们：签名与语义都没动，改了才是越界。
       钉成断言是为了"谁以后动这一族，先在这儿留下读数"。 */
    const calls = [...A1.matchAll(/this\._loadColor\(/g)].length
    if (calls === 3) ok(`_loadColor 的消费点仍恰 3 处（CPU／内存／GPU），签名未变＝本轮未动调用点`)
    else bad('负载色的消费点数了', `实际 ${calls} 处，应为 3 处（授权是"只许动那三个调用点"，不是"必须动")`)
  }
}

{
  /* **收编不等于并道**的那道闸。两问：值不许撞、源码不许引用。
     第一版派单说"当前数值恰好相同是巧合"——实测**连相同都不存在**（两族 4×4=16 对
     逐对比过，0 对同值），所以把 LOAD.HIGH 指回 STATE.CRIT 当场就会改画面：
     #f44336 → #f85149。这道闸因此不是洁癖，是一支会动像素的探针。 */
  const clash = []
  for (const [sk, sv] of Object.entries(STATE)) {
    for (const [lk, lv] of Object.entries(LOAD)) {
      if (String(sv).toLowerCase() === String(lv).toLowerCase()) clash.push(`${lk}===STATE.${sk}(${sv})`)
    }
  }
  const keys = Object.keys(LOAD).sort().join(',')
  const src = readSrc('lib/palette.js')
  const loadBlock = /export const LOAD = \{([\s\S]*?)\n\}/.exec(src)
  /* 只认**赋值位置**的 `: STATE.`（真并道长这样：`HIGH: STATE.CRIT`）。
     第一版写的是 `/\bSTATE\s*\./`，结果变异 F 里它命中的是**我自己在注释里写的
     "指回 STATE.CRIT"**——那是一次误红的实测，不是推演。注释里提一句状态色是合法的事。 */
  const byRef = !!(loadBlock && /:\s*STATE\s*\./.test(loadBlock[1]))
  if (keys === 'HIGH,LOW,MID,NONE' && !clash.length && !byRef) {
    ok(`两族各走各的通道：LOAD 键集合 = ${keys}；与 STATE 的 16 对逐对比 0 同值；LOAD 块里 0 处把值写成 STATE.*（正对照：同一条尺子在 STATE 自己那族量到 ${Object.keys(STATE).length} 支）`)
  } else bad('负载族与状态族并道了（本包越界即作废重做）', `键=${keys}; 同值对=${clash.join(', ') || '无'}; 源码引用 STATE=${byRef}`)
}

{
  /* 保持原值：四支必须等于 `_loadColor` 收编前那四个 0x 字面量。
     派单把"负载色要不要改值"列为**交他眼睛判**的项 ⇒ 本包只搬家、不调色。
     这条断言就是那句"只登记不改值"的可重跑形态。 */
  const WANT = { NONE: '0x455a64', LOW: '0x4caf50', MID: '0xff9800', HIGH: '0xf44336' }
  const drift = Object.entries(WANT).filter(([k, v]) => LOAD[k]?.toLowerCase() !== `#${v.slice(2)}`).map(([k, v]) => `${k}=${LOAD[k]}（应为 ${v}）`)
  if (!drift.length) ok(`LOAD 四支值逐字节等于收编前的字面量（${Object.values(WANT).join(' ')}）＝只搬家没调色`)
  else bad('负载色被顺手改了值', drift.join('; ') + ' —— 这三档的具体颜色是"留给眼睛"的裁量项，本包无权改')
}

{
  /* 负载族**不进** check-tokens 的成对表：DOM 侧没有"负载色"这块图例可对照，
     硬配一支就是造一个假事实（与 COOLANT／LIGHTING 同一判法，任务书 §6.5）。
     正对照＝同一条扫描读得到 STRUCT 那 12 对，所以"LOAD 0 对"是读数不是漏扫。 */
  const gate = readFileSync(new URL('./check-tokens.mjs', import.meta.url), 'utf8')
  const pairsOf = (g) => [...gate.matchAll(new RegExp(`\\['${g}'\\s*,`, 'g'))].length
  const PAIRED = ['STATE', 'GROUND', 'NEUTRAL', 'STRUCT']
  const blind = PAIRED.filter((g) => pairsOf(g) === 0)
  if (pairsOf('LOAD') !== 0) bad('负载族被塞进了成对表', `check-tokens 里出现 ${pairsOf('LOAD')} 条 ['LOAD', …] —— DOM 侧没有负载图例，配上去就是造一个假事实（同 COOLANT／LIGHTING 判法）`)
  else if (blind.length) bad('负载族配对扫描缺正对照', `同一条尺子在 check-tokens 里读不到 ${blind.join('/')} 任何一条成对 ⇒ 那个"LOAD 0 对"不算读数，尺子瞎了`)
  else ok(`负载族没被塞进 DOM↔WebGL 成对表：check-tokens 里 LOAD 0 对（正对照：同一条尺子读到 ${PAIRED.map((g) => `${g} ${pairsOf(g)}`).join('／')} 条成对声明）`)
}

console.log(`\n[selftest-silhouette] pass=${pass} fail=${failures.length}`)
process.exit(failures.length ? 1 : 0)
