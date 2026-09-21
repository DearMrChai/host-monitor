/**
 * palette.js — the WebGL side's single source for state colour (S4 §1.2).
 *
 * A canvas has no DOM layer, so a three.js renderer cannot read a CSS custom
 * property. That leaves two consumers of one fact, which is the same split H9
 * was about: `style.css :root` serves the DOM, this file serves the scene, and
 * `scripts/check-tokens.mjs` fails the build if the two ever disagree.
 *
 * Scope note: the motherboard's PCB green / copper / gold in `TopologyRenderer.js`
 * are the colours of physical objects, not of a status dimension, so S4 §1.1
 * rule 1 does not apply to them and they stay where they are.
 *
 * Why the **structure** family lives here too (V3 cut 2, 任务书 §6.1): cut 1 put
 * those tokens in `style.css :root` only, while their other consumer — the 3D bus
 * traces — reads this file. That is the same "one fact, two homes" shape H9 was
 * about, and `check-tokens.mjs` could not see it because its pairing table never
 * listed the structural keys. So `STRUCT` below mirrors `:root` key for key and
 * the gate now covers all twelve; `COOLANT` is deliberately *not* paired, because
 * the DOM has no legend swatch for a liquid.
 */

/** The four states, as the scene sees them (matches `--green/--orange/--red`). */
export const STATE = {
  OK: '#3fb950',
  WARN: '#d29922',
  CRIT: '#f85149',
  OFFLINE: '#9aa0a6',
}

/** Text-tone pair for each state, for anything drawn into a canvas texture.
 *
 *  V3 暗底色表 §3 asks for this whole family to be **deleted** (R-2: on a dark
 *  ground the face colour is already light enough to read as type, so a second
 *  set of values per state is what breaks 一色一事实). Deleting the names is not
 *  a two-file change: 54 `var(--ok-ink/--warn-ink/--crit-ink)` sites across 14
 *  .vue files have to be re-pointed, and `scripts/check-tokens.mjs:57-59` hard-
 *  requires the INK <-> --*-ink pairing to exist. Both are outside this cut.
 *
 *  What this cut does is honour R-2's substance: the values now **are** the state
 *  faces (§2.3). The paper-era trio (#1a7f37/#9a6700/#b62324) measured CR 3.76 /
 *  3.92 / 2.96 against the new `#0b1015` ground — all under the 4.5 text gate,
 *  i.e. a real legibility regression at every site, not an intermediate state.
 *  So the keys stay (no dangling references) and collapse onto one value each.
 *
 *  Note: these must stay literal '#rrggbb'. check-tokens.mjs scrapes palette.js
 *  with a hex regex, so `ok: STATE.OK` would read as missing and fail the build.
 */
export const INK = {
  ok: '#3fb950',
  warn: '#d29922',
  crit: '#f85149',
}

/** Scene grounds, so a re-skin is one file rather than four scattered literals.
 *  色表 §2.1 / R-3: three ground layers, deliberately a 1.12 / 1.17 step apart —
 *  depth comes from the faces, card edges come from `--border`. Lifting the
 *  panels further is the classic dark-mode error. */
export const GROUND = {
  bg: '#0b1015',
  plate: '#131d28',
  gridMajor: '#1d2a38',
  gridMinor: '#18222d',
}

/**
 * Absence and "no link data" are treatments of grey, never fifth states
 * (S1 §3.2, S3 §4.3).
 *
 * 色表 §2.4 reverses their shape for a dark ground (R-2): absence no longer
 * reads as *lighter than the floor* — that channel is taken by "has a state".
 * Both values now sit in the thin-stroke band (CR 3.22 / 3.26 against the
 * ground): **no fill, dashed stroke only**, kept under every state colour
 * (lowest 5.70) so absence can never outshout an alarm. The 0.72 scale and the
 * dashing stay the caller's job — that is renderer geometry, untouched here.
 */
export const NEUTRAL = {
  absent: '#556675',
  noData: '#5b6672',
  /** The CRIT blink overlay - a pulse on an object that is already lit, not a
   *  colour of its own. 色表 §2.3/§4-b changes the value: the paper-era #ff2200
   *  sat ΔE≈140 from STATE.CRIT, outside R-4's 25~90 same-family band, so on a
   *  dark ground it would read as a fifth state. #ff6a5a is ΔE≈57 from CRIT. */
  alarm: '#ff6a5a',
}

/** Structure family (parts / buses) — V3 暗底色表 §2.5 / R-1, byte-for-byte the
 *  twelve `:root` tokens, and pinned to them pair by pair by check-tokens.mjs.
 *
 *  R-1 is why these are *cold* hues: green / amber / red are the alarm channel's
 *  and neutral grey is OFFLINE's, so a structural colour that drifts into any of
 *  those four tells "this bus is carrying traffic" and "this box has a problem"
 *  with the same pixel. Part colours intentionally equal their bus colour (ram=ddr,
 *  gpu=pcie16, storage=pcie4, pch=nvlink) — that sameness *is* the claim "this chip
 *  hangs off that bus", and it is asserted, not coincidental (§2.5 补 3).
 *
 *  PCIe x1 has no key on purpose (§2.5 补 2): its old value sat ΔE 19 from `cpu`
 *  and 24 from `dmi`, below the 25 floor, so adding it would manufacture "more
 *  tiers than anyone can tell apart". x1 vs x4 is carried by trace *width*
 *  (0.10 vs 0.16) — hue says which group, width says which generation.
 *
 *  Like INK, these must stay literal '#rrggbb': check-tokens.mjs scrapes this file
 *  with a hex regex, so `ddr: STRUCT.ram` would read as missing and fail the build. */
export const STRUCT = {
  ddr: '#58a6ff',
  pcie16: '#bc8cff',
  pcie4: '#39c5cf',
  nvlink: '#f778ba',
  dmi: '#6e8898',
  sata: '#8d6e63',
  cpu: '#7d8fa8',
  ram: '#58a6ff',
  gpu: '#bc8cff',
  storage: '#39c5cf',
  pch: '#f778ba',
  nic: '#7d9fb8',
}

/** Coolant inside the memory water block — 色表 §6.
 *
 *  Same value as STRUCT.ram, different key, and that is the point: "the RAM
 *  subsystem" and "the fluid in this block" are two facts, so they get two names
 *  (R-1 asks for one home per fact, not one name per value). Merging them would
 *  cost the ability to tune the coolant's look on its own — §6 notes it is the one
 *  thing on this screen most likely to be called too bright or too plastic.
 *
 *  Not in check-tokens' pairing table: it exists only on the WebGL side, the DOM
 *  legend has no coolant swatch to disagree with (任务书 §6.5). */
export const COOLANT = '#2196f3'

/** '#rrggbb' -> 0xrrggbb, the only form three.js setters accept. */
export function toRGB(hex) {
  return parseInt(hex.replace('#', ''), 16)
}

/** Level -> scene colour as a number. Unknown/absent levels keep their caller's
 *  choice: this function does not guess, so a typo cannot silently render green. */
export function levelColor(level) {
  const hex = STATE[level]
  return hex == null ? null : toRGB(hex)
}

export default { STATE, INK, GROUND, NEUTRAL, STRUCT, COOLANT, toRGB, levelColor }
