/**
 * palette.js — the WebGL side's single source for state colour (S4 §1.2).
 *
 * A canvas has no DOM layer, so a three.js renderer cannot read a CSS custom
 * property. That leaves two consumers of one fact, which is the same split H9
 * was about: `style.css :root` serves the DOM, this file serves the scene, and
 * `scripts/check-tokens.mjs` fails the build if the two ever disagree.
 *
 * Scope note: only **state** and **ground** colours live here. The motherboard's
 * PCB green / copper / gold in `TopologyRenderer.js` are the colours of physical
 * objects, not of a status dimension, so S4 §1.1 rule 1 does not apply to them
 * and they stay where they are.
 */

/** The four states, as the scene sees them (matches `--green/--orange/--red`). */
export const STATE = {
  OK: '#3fb950',
  WARN: '#d29922',
  CRIT: '#f85149',
  OFFLINE: '#9aa0a6',
}

/** Text-tone pair for each state, for anything drawn into a canvas texture. */
export const INK = {
  ok: '#1a7f37',
  warn: '#9a6700',
  crit: '#b62324',
}

/** Scene grounds, so a re-skin is one file rather than four scattered literals. */
export const GROUND = {
  bg: '#f5f0e6',
  plate: '#efe8d9',
  gridMajor: '#d8cfbe',
  gridMinor: '#e4dccb',
}

/**
 * Absence and "no link data" are treatments of grey, never fifth states
 * (S1 §3.2, S3 §4.3): absence reads lighter and is shaped differently by the
 * caller (dashed card border, 0.72 scale in the scene).
 */
export const NEUTRAL = {
  absent: '#d8d2c6',
  noData: '#bdb5a6',
  /** The CRIT blink overlay - deliberately brighter than STATE.CRIT because it
   *  is a pulse on an object that is already lit, not a colour of its own. */
  alarm: '#ff2200',
}

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

export default { STATE, INK, GROUND, NEUTRAL, toRGB, levelColor }
