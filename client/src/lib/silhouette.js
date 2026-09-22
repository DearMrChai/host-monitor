/**
 * silhouette.js — the three shape tiers of the 陈列架 (V3 包 1, 任务书 B §1.2)
 *
 * Why this lives in `lib/` next to `palette.js` rather than inside the renderer:
 * the numbers below are the thing two things have to agree about — the WebGL
 * scene builds its boxes from them, and `scripts/selftest-silhouette.mjs`
 * projects them into a 60×60 slot to prove the tiers are still tellable apart.
 * A constant only the renderer can see is a constant nobody can check, which is
 * the same "one fact, one home" reasoning that put the state colours and the
 * lighting rig in `palette.js` (S4 §1.2 / 任务书 §5.1 前置 4.0).
 *
 * The three tiers are 素材清单 §7.2 as he ruled it on 09-22: **three tiers, all
 * horizontal** (卧式薄板 / 卧式方盒 / 卧式超宽), because 142 and x99 both went to
 * the rack tier and the upright tiers lost their machines. Two rules bind here:
 *
 *   1. **真比例不许归一化进同一个槽口** (§7.2 收为规则). Every tier carries its own
 *      `ratio` *and* its own absolute `unit`, so the projected pixel sizes stay
 *      different. The slot (`SHELF.slotPitchWorld`) is the cell pitch — a
 *      placement rule, not a mould. Scaling a tier to fit the slot would silently
 *      eat 大小, one of the only three axes that separate tiers at all; the
 *      selftest keeps a normalising helper precisely to prove that failure.
 *   2. **站姿 + 高宽比 + 大小 是档间唯一区别** (§7.2 核心规则). No ears, no grille,
 *      no row of front LEDs, no logo — 挂耳/格栅/灯点/logo 一律不当识别特征, because
 *      at 60px they blur into mush. So a tier is *one box*, and the only
 *      per-tier information is its proportions.
 *
 * 高:宽:深 follows §7.2 literally. `unit` (absolute size) is mine — the table
 * gives proportions, not centimetres — so it is listed in the delivery's
 * "我猜的" and is one number per tier to change.
 */

export const SILHOUETTE_TIERS = {
  /** §7.2 笔记本 · 卧式薄板 1:16:11 — the thin slab. */
  laptop: {
    label: '笔记本 · 卧式薄板',
    shortLabel: '笔记本',
    ratio: { h: 1, w: 16, d: 11 },
    unit: 0.09,
  },
  /** §7.2 微型机箱 · 卧式方盒 1:1.4:1.6 — narrowest footprint, tallest of the three. */
  mini: {
    label: '微型机箱 · 卧式方盒',
    shortLabel: '微型机箱',
    ratio: { h: 1, w: 1.4, d: 1.6 },
    unit: 0.5,
  },
  /** §7.2 机架式机箱 · 卧式超宽 1:4~8:3 — the widest趴着的一条.
   *  I take the 8 end of the range: it is the reading his own picked mock
   *  (slice-a0-v2, "卧式超宽 挺好的") drew, and it is what buys width separation
   *  from the laptop tier at 60px. */
  rack: {
    label: '机架式机箱 · 卧式超宽（不上柜）',
    shortLabel: '机架式机箱',
    ratio: { h: 1, w: 8, d: 3 },
    unit: 0.32,
  },
}

/** Unknown form factor stays 微型方盒 (per 任务书 B: 默认落"微型方盒"). */
export const SILHOUETTE_DEFAULT = 'mini'

/**
 * Placeholder tier assignment (V3 包 1). This is a *display* heuristic over the
 * two strings the client already has — `name` (display_name) and `id` (host_id).
 * It is not a fact about the machine and it is not a data source: the honest
 * home is the roster's form-factor column (任务书 B 包 3), which is why nothing
 * here reads the agent, `_guess_host_type` or the server.
 *
 * Per his own naming habit (决策 10 W3: 单机群、按他的场景定制, 收窄不算缺陷) the
 * hints include the host numbers he uses: `i9-12900H-124` carries no form word
 * at all, so name keywords alone would never place the notebook tier.
 */
const TIER_HINTS = [
  { tier: 'laptop', words: ['笔记本', 'laptop', 'notebook', 'macbook'], ids: ['124'] },
  { tier: 'rack', words: ['机架', 'rack', '服务器', 'server'], ids: ['142', 'x99'] },
  { tier: 'mini', words: ['微型', '迷你', '小主机', 'mini', 'itx'], ids: ['231'] },
]

/** Word-boundary test for a host_id hint: `124` must not match inside `1240`. */
function hasIdToken(id, token) {
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(id)
}

/**
 * @param {object} rec a topology view-model record ({ id, name, ... })
 * @returns {string} a key of SILHOUETTE_TIERS
 */
export function silhouetteTierOf(rec) {
  const name = String(rec?.name ?? '').toLowerCase()
  const id = String(rec?.id ?? '').toLowerCase()
  for (const hint of TIER_HINTS) {
    if (hint.words.some((w) => name.includes(w) || id.includes(w))) return hint.tier
    if (hint.ids.some((t) => hasIdToken(id, t) || (name && hasIdToken(name, t)))) return hint.tier
  }
  return SILHOUETTE_DEFAULT
}

/** World-unit size of one tier: ratio × unit. Kept as a function so the numbers
 *  above stay the single source — the ratio and the size can never disagree. */
export function silhouetteSize(tierKey) {
  const tier = SILHOUETTE_TIERS[tierKey] ?? SILHOUETTE_TIERS[SILHOUETTE_DEFAULT]
  const { h, w, d } = tier.ratio
  return { height: h * tier.unit, width: w * tier.unit, depth: d * tier.unit }
}

/**
 * The 陈列架 layout rule (任务书 B §1.1). All numbers, because "格宽溢出折成两排"
 * (X15) has to be checkable rather than felt: the fold is a floor() over the
 * container width against one slot width, capped at `maxSlotsPerRow`.
 *
 * World units and pixels meet at `slotWidthPx : slotPitchWorld` = 70.6px per world
 * unit at the wall scale, and the 60×60 judgement row of §7.2 is the same
 * geometry one quarter across (17.6px per unit) — that is the reading the
 * selftest prints, and the reason `slotPitchWorld` is the only knob that may
 * relate a size to a slot: it is a divisor of the *pitch*, never a mould for a
 * machine. The pitch is 3.4 rather than 3 because the widest tier's plinth
 * (2.56 + 2×0.25 = 3.06) must still fit inside one cell with clearance; at 3.0
 * two neighbouring racks would grind plates together.
 */
export const SHELF = {
  slotWidthPx: 240,        // 每格槽宽（墙上的量级）
  slotPitchWorld: 3.4,     // 槽口的世界单位宽度 = 排布间距，不是尺寸的模子
  rowPitchWorld: 2.6,      // 折第二排（往上层）的间距
  maxSlotsPerRow: 4,       // 一排最多几格；超过就进下一排
  wrapAtContainerWidthPx: 960, // = maxSlotsPerRow × slotWidthPx：容器窄于此值即出现第二排
  baseY: 0.7,              // 组的世界高度（地牌落在地面上，沿用现值）
  bodySeatY: 0.44,         // 机体底面坐在牌面上（沿用现值：机体 y = 0.44 + 高/2）
  plinthThickness: 0.22,   // 地牌厚度（沿用现值；放这里是为了让折行不变量可被自检算）
  plinthMargin: 0.25,      // 地牌比机体每侧多出的边（最宽档 + 两侧边必须仍小于槽距）
  labelAboveBody: 0.66,    // 标签牌锚点高出机体顶面的量（牌面仍由 DOM 画）
  plateHalfHeight: 0.18,   // 取景时给牌面留的半高（世界单位）
  tiltRatio: 0.16,         // 甲档"镜头略俯"：机位高于中心 tan(9.1°)×距离；yaw 恒为 0
  sidePad: 0.6,            // 取景左右留白（下边不留：地牌就是落在地面上，取景按牌底算）
  fitPadding: 1.12,        // 贴合之后再退 12%
  maxCameraDistance: 60,   // 沿用原 _fitRadius 的上限
}

/** How many slots a row holds, and how many rows the fleet needs, in container px. */
export function shelfGrid(count, containerWidthPx) {
  const cols = Math.max(1, Math.min(SHELF.maxSlotsPerRow, Math.floor((containerWidthPx || 0) / SHELF.slotWidthPx)))
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) }
}

export default { SILHOUETTE_TIERS, SILHOUETTE_DEFAULT, silhouetteTierOf, silhouetteSize, SHELF, shelfGrid }
