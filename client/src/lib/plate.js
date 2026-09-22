/**
 * plate.js — 陈列架的**牌面轴** (V3 包 2 步 1)
 *
 * "这一格写什么字、字怎么排" has exactly one home: this file builds the DOM and
 * owns every class name on it, the renderer owns none. Before this module the
 * plate was written in three places at once — one `innerHTML` template in the
 * renderer plus two `querySelector('.tl-name')` style selectors — which is the
 * shape this repo keeps having to name (H9: 一个事实两个家). Editing the plate's
 * layout is now: this file for structure, `style.css` for looks, nothing else.
 *
 * Two boundaries this module does **not** cross:
 *
 *   - **没有样式**. No `style.color`, no hex, no `0x…`: colours are one CSS
 *     declaration block away (`style.css`'s `.topo-label` rules) and a second
 *     home for a colour is what `check-tokens.mjs` exists to catch. 色值一个自创
 *     都不许有，所以这里连"内联一个色"都不做。
 *   - **没有第二套截断**. The name arrives already truncated: `topology-vm.js`
 *     applies `shortName(displayName(h), nameMax)` (§1.3 的"节点名 ≤8 字"), and the
 *     kiosk passes `L0_NAME_MAX`. Re-cutting it here would make the wall and the
 *     scene disagree about a machine's name at one more character.
 *
 * And the honesty rule the copy is subject to: 缺席/失联那两行小字是**诚实性文案**
 * ——任务书 B §2 那张假快照里 `ghost-box`（缺席）与 `x99-rack`（OFFLINE）就是要分开的
 * 两件事。这两句字面搬自重构前的渲染器，照字保留，不润色成更好听的说法。
 */

/** Root class. `topo-label` is the CSS2D hook the whole app styles (A0's host
 *  plates and A1's chip labels alike); `topo-host` marks *this* screen's plate,
 *  so a change to the 陈列架's typography cannot reach into 详情页 — that page is
 *  off-limits this round and shares the base rules. */
const ROOT_CLASS = 'topo-label topo-host'
const NAME_CLASS = 'tl-name'
const SUB_CLASS = 'tl-sub'

/** 牌面小字的口径：一台在场且活着的机器没有可写的状态句（状态在墙上由机体色相
 *  承担，不在牌面上重复一遍），所以它的 sub 是空串而不是"正常"。
 *  两支非空文案照字保留自 V3 包 1 之前的渲染器，未做润色。 */
const SUB_ABSENT = '离场（临时节点，不报警）'
const SUB_OFFLINE = '失联'

/**
 * The plate's small print, as one function over the two honest booleans.
 * 优先级是定死的：absent 赢 online —— 「离场（临时节点，不报警）」说的是"这台不
 * 该被报警"，先说出来才不会把一张临时节点的离开读成一次失联。
 *
 * @param {{ absent?: boolean, online?: boolean }} rec
 * @returns {string} '' when there is nothing honest to say
 */
export function plateSub(rec) {
  if (rec?.absent) return SUB_ABSENT
  if (!rec?.online) return SUB_OFFLINE
  return ''
}

/**
 * Build one host's plate. Built with `createElement` + class assignment rather
 * than an HTML template string, because `display_name` is user-editable text
 * (改名 in HostCard) and interpolating it into `innerHTML` is a live injection
 * path, not a formatting choice.
 *
 * @returns {HTMLElement} the element to hand to a `CSS2DObject`
 */
export function createPlateEl() {
  const root = document.createElement('div')
  root.className = ROOT_CLASS
  const name = document.createElement('div')
  name.className = NAME_CLASS
  const sub = document.createElement('div')
  sub.className = SUB_CLASS
  root.append(name, sub)
  return root
}

/**
 * Write the plate. Cheap and idempotent — it is called on every 2 s push, so it
 * compares before touching anything: rewriting `textContent` (and re-measuring
 * the class list) for a host that did not change is how a 24×7 wall ends up
 * thrashing layout on machines nobody is looking at.
 *
 * @param {HTMLElement} el the element from `createPlateEl()`
 * @param {{ name?: string, sub?: string, absent?: boolean, online?: boolean }} fields
 *        `sub` explicit text, or omit it and the plate derives it from
 *        `absent`/`online` via `plateSub` — the copy has one home either way
 */
export function updatePlate(el, { name, sub, absent, online } = {}) {
  if (!el) return
  const nameText = name ?? ''
  const nameEl = el.querySelector(`.${NAME_CLASS}`)
  if (nameEl && nameEl.textContent !== nameText) nameEl.textContent = nameText
  const subText = sub === undefined ? plateSub({ absent, online }) : sub
  const subEl = el.querySelector(`.${SUB_CLASS}`)
  if (subEl && subEl.textContent !== subText) subEl.textContent = subText
  // 空的小字不许留一条空带子在牌面上（步 2 的排版靠这一格决定要不要分界）
  el.classList.toggle('plate-no-status', !subText)
}

export default { createPlateEl, updatePlate, plateSub }
