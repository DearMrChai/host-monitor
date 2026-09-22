import { sortHostsForOverview, deviceLevel, displayName, isAbsent, shortName, loadOf } from './status.js'

/**
 * The single hosts[] -> scene mapping (S4 §2.2).
 *
 * Three consumers draw or list the same fleet - the 拓扑 tab, the kiosk's 3D
 * scene, and the kiosk's CSS fallback wall. Each one used to own its own
 * translation, which is how "one fact, one source" dies quietly: the wall and
 * the scene would have disagreed about which machine is in trouble.
 *
 * opts.nameMax truncates the plate at L0 distance (§1.3: 节点名 ≤8 字). It is an
 * option rather than a second function because everything *except* the name
 * length has to stay identical between the two views - "升一档只能多问一句,
 * 不能改口径".
 *
 * Sorting is pre-applied because both layouts are positional: the caller's order
 * is the seat order along the shelf (and down the wall), so it has to be deterministic.
 */
export function topologyViewModel(hosts, opts = {}) {
  const { nameMax = 0 } = opts
  return sortHostsForOverview(hosts).map(h => ({
    id: h.host_id,
    name: nameMax ? shortName(displayName(h), nameMax) : displayName(h),
    deviceLevel: deviceLevel(h),
    linkLevel: h.status?.components?.link?.level || null,
    online: !!h.online,
    absent: isAbsent(h),
    /* V3 假辉光·案甲 (任务书 §5.1): the scene's one brightness channel reads this
       number, so it travels with the record instead of being recomputed downstream
       - `loadOf` is the repo's only 负载 口径 and a second max() in a renderer is
       exactly how the wall and the scene start disagreeing about who is busy.
       -1 means "no metrics", not "idle"; consumers must keep those apart. */
    load: loadOf(h),
    links: (h.status?.components?.link?.targets || []).map(t => ({
      key: t.target, name: t.name, rtt: t.rtt_ms, loss: t.loss_pct, level: t.level,
    })),
  }))
}

/**
 * The same records flattened for the DOM wall (S4 §2.2: "同一份快照、同一套令牌、
 * 同一套术语"), with two additions the CSS variant needs and the scene computes
 * for itself: the single number to print big, and the one word saying why a
 * machine is grey.
 *
 * level stays inside the four-state vocabulary plus ABSENT, which borrows 失联's
 * grey and differs by shape (S1 §3.2) - the wall gets no fifth colour either.
 */
export function topologyTiles(hosts, opts = {}) {
  const vm = topologyViewModel(hosts, opts)
  const byId = new Map(hosts.map((h) => [h.host_id, h]))
  return vm.map((n) => {
    const h = byId.get(n.id)
    const load = h ? loadOf(h) : null
    return {
      ...n,
      level: n.absent ? 'ABSENT' : (n.online ? (n.deviceLevel || 'OK') : 'OFFLINE'),
      value: n.absent || !n.online ? null : (load >= 0 ? Math.round(load) : null),
      // 离场 = a temporary node that left, 缺席 = the roster trusted it to be
      // here, 失联 = a persistent node we stopped hearing from (S3 §4.3).
      note: n.absent ? '离场' : !n.online ? (isAbsent(h) ? '缺席' : '失联') : '',
    }
  })
}
