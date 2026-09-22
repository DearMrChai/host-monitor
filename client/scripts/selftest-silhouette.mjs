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
} from '../src/lib/silhouette.js'

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
  const expect = SHELF.maxSlotsPerRow * SHELF.slotWidthPx
  if (SHELF.wrapAtContainerWidthPx === expect && SHELF.slotWidthPx === 240 && SHELF.maxSlotsPerRow === 4) {
    ok(`折行阈值可核对：容器窄于 ${expect}px（= maxSlotsPerRow ${SHELF.maxSlotsPerRow} × 槽宽 ${SHELF.slotWidthPx}px）即出现第二排`)
  } else {
    bad('折行阈值必须等于 每排格数 × 槽宽', `${SHELF.wrapAtContainerWidthPx} ≠ ${expect}`)
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

console.log(`\n[selftest-silhouette] pass=${pass} fail=${failures.length}`)
process.exit(failures.length ? 1 : 0)
