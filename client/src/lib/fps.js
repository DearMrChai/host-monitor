/**
 * Rolling frame-rate guard (S4 §1.4)
 * ==================================
 * The 副屏 is a GT 1030 driving a 1080p wall 24/7, next to whatever else 231 is
 * doing. A 3D scene that cannot hold a frame rate is worse than no 3D scene: it
 * stutters in the corner of your eye forever, and it eats the GPU the video
 * player wanted. So the scene has to be able to fire itself.
 *
 * The rule the design doc settled on: a full 30s window whose mean falls below
 * 20fps degrades to the CSS flat wall. Two details that are the whole point of
 * this module -
 *
 *  - The judgement is made by a timer, not by the frames themselves, because the
 *    failure mode "the renderer stopped drawing altogether" produces no frames
 *    to notice it with.
 *  - Degradation is one-way and visible. A silent swap would mean the viewer
 *    never learns the machine is struggling, and "why did the pretty view
 *    disappear" is a worse question than "why is it running at 11fps".
 */

export const FPS_DEFAULTS = {
  threshold: 20,     // below this mean, give up on WebGL
  windowMs: 30_000,  // the rolling window the mean is taken over
  /* A judgement needs a *full* window. minSpanMs === windowMs is what makes the
     rule "30s below 20fps" rather than "whatever has been sampled so far
     averages out badly", and the difference matters only for a transient:
     degradation is one-way, so a false positive during the first 30s - which is
     exactly what a cold start with a shader compile looks like - would cost the
     3D for the rest of the week. Waiting one more window to be sure is free on a
     screen that runs forever. */
  minSpanMs: 30_000,
  graceMs: 5_000,    // no judgement at all before this, however full the window is
  checkMs: 5_000,    // how often the window is evaluated
}

/**
 * @param {(info:{fps:number,spanSec:number})=>void} [opts.onDegrade]
 * @returns {{tick:()=>void, start:()=>void, stop:()=>void,
 *            fps:(at?:number)=>number, check:()=>void, degraded:()=>boolean}}
 */
export function createFpsGuard(opts = {}) {
  const {
    threshold, windowMs, minSpanMs, graceMs, checkMs, onDegrade,
    /* The clock is an injection, not a hidden global, so the rule can be tested
       at all: "30s under 20fps" needs a GPU that is genuinely struggling, which
       is not something a self-test can produce on demand - and a degrade path
       that has never been observed firing is a degrade path that is broken. */
    now = () => performance.now(),
  } = { ...FPS_DEFAULTS, ...opts }
  const t0 = now()
  let stamps = []
  let timer = null
  let fired = false

  /** Call once per rendered frame (wired to ClusterTopologyRenderer.onFrame). */
  function tick() {
    stamps.push(now())
    /* check() prunes every 5s; this bound only matters if timers are starved
       (a throttled background tab), where an unbounded array would be the leak. */
    if (stamps.length > 2400) stamps = stamps.filter(s => s >= now() - windowMs)
  }

  /** Frames per second inside the trailing window, over the part actually seen. */
  function fps(at = now()) {
    const from = Math.max(at - windowMs, t0)
    const span = (at - from) / 1000
    if (span <= 0) return threshold
    return stamps.filter(s => s >= from).length / span
  }

  function check() {
    const at = now()
    if (fired) return
    // A hidden document draws nothing; that is the pause rule working, not a stall.
    if (typeof document !== 'undefined' && document.hidden) return
    if (at - t0 < graceMs) return
    const from = Math.max(at - windowMs, t0)
    if (at - from < minSpanMs) return
    stamps = stamps.filter(s => s >= from)
    const mean = fps(at)
    if (mean >= threshold) return
    fired = true
    stop()
    onDegrade?.({ fps: mean, spanSec: (at - from) / 1000 })
  }

  function start() {
    if (timer || fired) return
    timer = setInterval(check, checkMs)
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return {
    tick, start, stop, fps,
    /** Evaluate now. Exported because "would this have degraded me?" is a
     *  question the self-test has to be able to ask without waiting 30 seconds. */
    check,
    degraded: () => fired,
  }
}
