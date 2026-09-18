/**
 * Alert sounds (P2): WebAudio synthesized tones, zero asset files.
 * WARN = one-shot two-tone; CRIT/OFFLINE = three-tone descending, looped
 * every 2.5s while any is active. Browser autoplay policy requires a user
 * gesture -> unlock() is wired to a global pointerdown in App.vue.
 */
import { reactive } from 'vue'

export const sound = reactive({
  muted: localStorage.getItem('hm-muted') === '1',
  unlocked: false,
})

let ctx = null
let loopTimer = null

export function unlock() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    sound.unlocked = ctx.state === 'running'
  } catch (e) { /* audio unavailable */ }
}

export function toggleMute() {
  sound.muted = !sound.muted
  localStorage.setItem('hm-muted', sound.muted ? '1' : '0')
}

function canPlay() {
  return ctx && ctx.state === 'running' && !sound.muted
}

function tone(freq, start, dur, gainPeak = 0.12) {
  const t0 = ctx.currentTime + start
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.05)
}

export function playWarn() {
  if (!canPlay()) return
  tone(880, 0, 0.15)
  tone(1175, 0.15, 0.2)
}

export function playCrit() {
  if (!canPlay()) return
  tone(660, 0, 0.15)
  tone(550, 0.16, 0.15)
  tone(440, 0.32, 0.25)
}

export function setCritLoop(on) {
  if (on && !loopTimer) {
    playCrit()
    loopTimer = setInterval(() => { if (canPlay()) playCrit() }, 2500)
  } else if (!on && loopTimer) {
    clearInterval(loopTimer)
    loopTimer = null
  }
}
