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
 * the DOM has no legend swatch for a liquid — same reason `LIGHTING` is not
 * paired: the DOM has no concept of a lamp (V3 前置 4.0, 任务书 §5.1).
 */

/** The four states, as the scene sees them (matches `--green/--orange/--red`).
 *  On a dark ground these double as the text tones — one family per state, per
 *  R-2 / 色表 §3: a second set of values per state is what breaks 一色一事实. */
export const STATE = {
  OK: '#3fb950',
  WARN: '#d29922',
  CRIT: '#f85149',
  OFFLINE: '#9aa0a6',
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
 * Lighting rig — V3 翻暗 前置 4.0 (任务书 §5.1). The three lamps used to live in
 * `ClusterTopologyRenderer` as un-palettised literals. Only the *intensities*
 * moved here (ambient 0.75 / key 0.9 / fill 0.35 → 0.20 / 0.70 / 0.25): a white
 * ambient of 0.75 lifted the whole dark ground toward neutral grey, which is
 * R-3's "raise everything to get depth" error played through the lighting
 * channel, and depth now has to come back to the faces themselves.
 *
 * The hues are byte-for-byte what the paper-era rig shipped with, **on purpose**.
 * Whether the ivory key survives on a dark ground is his call, not this cut's
 * (§5.1 把它明确留给眼睛), and moving colour and intensity in the same step makes
 * the eye reading unattributable. The whole hue question is now a three-value
 * edit in this block — `#eef4fa` is the cool-white candidate for `key`.
 *
 * Carries `intensity` alongside `color` because the lamp is one fact: a rig that
 * lives in two files is the same shape H9 and §5.2 keep having to name, and the
 * tune this cut exists to enable happens here, once, in front of the screen.
 *
 * Illumination, not a colour dimension: these never paint an object, they only
 * shape faces, so R-1's four-state reservation is untouched. Deliberately *not*
 * in check-tokens' pairing table — the DOM has no concept of a lamp to disagree
 * with, which is exactly why COOLANT stays unpaired too (任务书 §6.5).
 */
export const LIGHTING = {
  ambient: { color: '#ffffff', intensity: 0.2 },
  key: { color: '#fff5e0', intensity: 0.7 },
  fill: { color: '#ddeeff', intensity: 0.25 },
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
 *  These must stay literal '#rrggbb': check-tokens.mjs scrapes this file
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

export default { STATE, GROUND, LIGHTING, NEUTRAL, STRUCT, COOLANT, toRGB, levelColor }
