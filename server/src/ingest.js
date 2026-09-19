/**
 * Ingest authorisation policy (S2).
 * Contract: S2-细化设计.md §2-§4.
 *
 * Why a separate module: the WebSocket handler should stay plumbing. Keeping
 * "may this frame write to the store" as one pure decision function means the
 * three enforcement modes are unit-testable without sockets, and there is
 * exactly one place where the fleet's trust rules live.
 *
 * Modes (HM_INGEST_TOKEN):
 *   off     v1 behaviour, kept as the escape valve - nothing is refused.
 *   legacy  default. An *unknown* host_id needs a valid pairing code; a node
 *           already in the roster may still report without a key, because the
 *           three production Agents predate this code and the iteration cadence
 *           forbids touching them mid-iteration. Keyless nodes are counted and
 *           surfaced in the UI, never silently accepted.
 *   strict  every frame needs a pairing code or the node's own key. Flip this at
 *           the milestone redeploy, once all Agents carry agent.json.
 *
 * Honest limits: transport is plaintext LAN WebSocket without TLS, so a key on
 * the wire is a write-permission, not a secret hidden from everyone else on the
 * network (S1 §5.2 says the same about the admin passphrase). What this gate
 * actually buys is the H8 property: nobody outside the roster can invent a node.
 */
import { roster } from './roster.js'

export const INGEST_MODES = ['off', 'legacy', 'strict']

const CODE_LEN = 12   // roster.issueEnroll: randomBytes(6).hex
const KEY_LEN = 32    // roster.newNodeKey:  randomBytes(16).hex

/** Machine reasons -> UI text. Keep keys stable: the self-test asserts on them. */
export const REASON_TEXT = {
  no_host_id: '帧未带 host_id',
  no_code: '未带配对码',
  unknown_code: '配对码不存在',
  code_expired: '配对码已过期',
  code_used_up: '配对码次数已用完',
  unknown_host: '未知节点，且未带有效配对码',
  bad_key: '节点密钥不正确',
  host_mismatch: 'metrics 帧与连接注册的节点不一致',
  fingerprint_drift: '同一 id 换了机器指纹（重装或克隆）',
}

const EVENTS_MAX = 20

function resolveMode() {
  const raw = String(process.env.HM_INGEST_TOKEN || '').trim().toLowerCase()
  return INGEST_MODES.includes(raw) ? raw : 'legacy'
}

/** 198.51.100.7 -> 198.51.*.*  |  ::ffff:203.0.113.9 -> 203.0.*.*  (examples use
 *  the RFC 5737 documentation range so no real address ever lands in this repo) */
export function maskAddr(addr) {
  if (!addr) return null
  const v4 = String(addr).match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) return `${v4[1]}.${v4[2]}.*.*`
  return '*.*.*.*'
}

class IngestGate {
  constructor() {
    this.mode = resolveMode()
    /** Newest-first audit trail: refusals plus one anomaly kind we accept. */
    this.events = []
    this.counts = { accepted: 0, accepted_legacy: 0, paired: 0, denied: 0, drift: 0 }
    console.log(`[Ingest] token enforcement mode: ${this.mode}`)
  }

  /**
   * Decide one register frame.
   * @param {{hostId:string|null, token?:string, addr?:string, fingerprint?:string}} req
   * @returns {{ok:boolean, paired?:boolean, node_key?:string, legacy?:boolean,
   *            drift?:boolean, reason?:string}}
   */
  authorize({ hostId, token, addr, fingerprint }, now = Date.now()) {
    if (!hostId) return this.#log(addr, hostId, 'no_host_id', now, false)
    if (this.mode === 'off') {
      this.counts.accepted += 1
      return { ok: true }
    }

    const keyOk = typeof token === 'string' && token.length === KEY_LEN && roster.keyMatches(hostId, token)
    // A 12-hex token that is not a known code is a typo or a revoked code, and
    // saying so is not a leak: it only reaches this branch when the node itself
    // is unknown, so the caller already has nothing to write.
    const codeShaped = typeof token === 'string' && token.length === CODE_LEN

    // 1) A pairing code spends one use and buys a fresh node key. Re-pairing a
    //    known node is allowed (key lost with a wiped disk); minting a new key
    //    retires the old one, since roster.ensure overwrites enroll_token.
    if (!keyOk && codeShaped) {
      const c = roster.consumeEnroll(token, hostId, now)
      if (c.ok) {
        this.counts.paired += 1
        console.log(`[Ingest] Paired ${hostId} via code (remaining: ${c.remaining ?? '∞'})`)
        return { ok: true, paired: true, node_key: roster.newNodeKey() }
      }
      // An unknown string could still be a key from an earlier build; anything
      // else is a code that failed on its own terms, so report that reason.
      if (c.reason !== 'unknown_code') return this.#log(addr, hostId, c.reason, now, false)
    }

    // 2) Standing per-node key.
    if (keyOk) {
      this.counts.accepted += 1
      return { ok: true, ...this.#drift(hostId, fingerprint, addr, now) }
    }

    // 3) legacy grace: already in the roster, no credential. Counted and shown.
    if (this.mode === 'legacy' && roster.get(hostId)) {
      this.counts.accepted_legacy += 1
      return { ok: true, legacy: true, ...this.#drift(hostId, fingerprint, addr, now) }
    }

    return this.#log(addr, hostId,
      codeShaped ? 'unknown_code' : roster.get(hostId) ? 'bad_key' : 'unknown_host',
      now, false)
  }

  /**
   * A metrics frame may only write to the node its own connection registered as
   * (S2 §4): without this, one accepted socket could rewrite any host_id.
   */
  frameHostMatches(connHostId, frameHostId, addr = null) {
    if (!connHostId) return false
    if (!frameHostId || frameHostId === connHostId) return true
    this.#log(addr, frameHostId, 'host_mismatch', Date.now(), false)
    return false
  }

  /**
   * Same id from different hardware. Accepted, but never silently: an OS
   * reinstall legitimately changes the fingerprint, so refusing here would be
   * a self-inflicted outage. This is the H4 tripwire, not an access control.
   */
  #drift(hostId, fingerprint, addr, now) {
    const want = roster.fingerprintOf(hostId)
    if (!want || typeof fingerprint !== 'string' || !fingerprint || fingerprint === want) return {}
    this.counts.drift += 1
    this.#log(addr, hostId, 'fingerprint_drift', now, true)
    console.log(`[Ingest] Fingerprint drift on ${hostId}: ${want.slice(0, 8)}… -> ${fingerprint.slice(0, 8)}…`)
    return { drift: true }
  }

  #log(addr, hostId, reason, now, accepted) {
    if (!accepted) this.counts.denied += 1
    this.events.unshift({ ts: now, addr: addr || null, host_id: hostId || null, reason, accepted: !!accepted })
    if (this.events.length > EVENTS_MAX) this.events.length = EVENTS_MAX
    if (!accepted) console.log(`[Ingest] REFUSED ${hostId || '(no id)'} from ${addr || '?'}: ${reason}`)
    return { ok: false, reason }
  }

  /** Recent abnormal ingest attempts, newest first (pairing page).
   *  Addresses come back subnet-only: "who got turned away" is worth showing,
   *  a full peer address in an unauthenticated API is not. */
  recentEvents() {
    return this.events.map((e) => ({ ...e, addr: maskAddr(e.addr), text: REASON_TEXT[e.reason] || e.reason }))
  }

  info() {
    return {
      mode: this.mode,
      counts: { ...this.counts },
      keyless_agents: roster.keylessAgents(),
      events: this.recentEvents(),
    }
  }

  /** Self-test hook: exercise one policy against another clock. */
  setMode(m) {
    if (INGEST_MODES.includes(m)) this.mode = m
    return this.mode
  }
}

export const ingest = new IngestGate()
