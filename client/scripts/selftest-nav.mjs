/**
 * selftest-nav.mjs — 竖切判据②③ 的可重跑断言（V3 包 3 步 1）
 *
 * 判据原文（任务书 B §3）：
 *   ② 一次点击进 A1、一次按键回 A0
 *   ③ 刷新／重开之后必是陈列架
 *
 * 这一档之前它们只活在交付说明的"我以为过了"里。这里把它们翻译成**读源码的结构判据**
 * ——仓库没有测试运行器（无 vitest），这几个 selftest 脚本就是全部安全网，风格沿用
 * `selftest-silhouette.mjs`：判据本身用正则读源文，每一处「零命中」当场喂一条
 * **已知该命中**的输入给同一条模式当正对照（色表纪律 R-6），对照打不中就判 FAIL。
 *
 * ⚠️ 这些断言量的是**代码链条在不在**，不是**手感**。真机点一下好不好用、kiosk 上点击
 * 该不该有、默认屏改成哪一屏——视觉与手感一律「未验证，交人眼看一次」。
 *
 * 实测结论（09-22 深夜，逐环开过行号，本轮零改动）写在本文件末尾的「结论」一节，
 * 也在提交说明里；一句话版：
 *   ② 前半（一次点击进 A1）非 kiosk 路径**通**、kiosk 路径**断**（断在一处已入库的
 *      交互决策上，S4 §2.5「值守屏无钻取」）；② 后半（一次**按键**回 A0）按字面口径
 *      **断**（A1 上没有任何键盘绑定，只有一颗返回按钮）。
 *   ③ 「不持久化视图／选中态」这一半**通**且已被钉住；「刷新必是陈列架」这一半在非
 *      kiosk 路径上**断**（默认落在「总览」＝T0 台账表，不是 A0）。
 * ⇒ 断的那几处**不自行修**：改默认落地屏、给墙上装点击、给 A1 加键盘出口，三条都是
 *   交互模型改动，交人裁。本文件钉的是**现状**，它们变红＝有人动了交互模型，
 *   那时要连判据文案一起改，不许静默变绿。
 *
 * Run: node client/scripts/selftest-nav.mjs   (exit 1 on failure)
 */
import { readFileSync, readdirSync } from 'node:fs'

let pass = 0
const failures = []
const ok = (name) => { pass++; console.log(`PASS  ${name}`) }
const bad = (name, why) => { failures.push(name); console.log(`FAIL  ${name}\n      ${why}`) }

/* ---------- 读源文 ---------- */

const readSrc = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/* "全仓"必须是真全仓：文件清单从 src/ 递归枚举，不是一份手抄名单——手抄名单会让
   下面那两条"零命中"漏掉清单外的文件（第一版就漏了 HudPanel／DrawerV3 这些）。 */
const SRC_FILES = readdirSync(new URL('../src/', import.meta.url), { recursive: true })
  .map(String)
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => /\.(?:vue|js)$/.test(f) && !f.endsWith('main.js'))
  .sort()

/* 判据读的是**代码**，不是散文：注释里写一句"@open="openDetail" 不该让链条判成齐。
   剥法比 selftest-silhouette.mjs 那台状态机粗（只剥块注释／整行行注释／HTML 注释），
   因为这里要判的都是模板属性与整句调用，字符串里出现 `//`（`ws://`）不会被它咬到——
   只认行首的 `//`。它自己也可能咬坏代码，所以下面有一道 CODE_INTACT 闸。 */
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^[ \t]*\/\/.*$/gm, '')

const codeOf = (rel) => stripComments(readSrc(rel))
const hits = (text, re) => [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))]
const nOf = (text, re) => hits(text, re).length

const APP = codeOf('App.vue')
const TOPO_VIEW = codeOf('views/TopologyView.vue')
const KIOSK_VIEW = codeOf('views/KioskView.vue')
const DETAIL_VIEW = codeOf('views/DetailView.vue')
const CLUSTER_BAR = codeOf('components/ClusterBar.vue')
const A0_RENDERER = codeOf('three/ClusterTopologyRenderer.js')
const HOST_CARD = codeOf('components/HostCard.vue')

/** 一个自定义标签的开标签属性串（`<TopologyView ...>` 里那段），取不到返回 null。 */
function tagAttrs(src, tagName) {
  const m = src.match(new RegExp(`<${tagName}\\b([\\s\\S]*?)(?:/?>)`, 'm'))
  return m ? m[1] : null
}

/* 尺子自己的闸：剥完注释，六个文件里各留一处必然存在的锚点。锚点读不到＝剥坏了
   或文件被挪走，下面所有"0 命中"都不是读数。 */
const CODE_INTACT = /function openDetail\(hostId\)/.test(APP)
  && /function backFromDetail\(\)/.test(APP)
  && /renderer\.enableClicks\(\)/.test(TOPO_VIEW)
  && /enableClicks\(\)\s*\{/.test(A0_RENDERER)
  && /const mode = ref\(/.test(KIOSK_VIEW)
  && /defineEmits\(\['back'\]\)/.test(DETAIL_VIEW)
  && /\$emit\('toggle', 'topology'\)/.test(CLUSTER_BAR)
  && /@keyup\.enter/.test(HOST_CARD)

/* =========================================================================
   A 组 · 判据② 前半：从陈列架到 A1 是不是"一次点击"
   ========================================================================= */

/* 链条四段：拾取 → 组件发 'open' → 外壳接住 → 状态机写 detail。
   反例（同一条尺子喂 SettingsView）必须报"缺"，否则这条判据是永真的。 */
{
  const LINKS = [
    ['拾取回调有名字', () => /this\.onNodeClick\s*\(/.test(A0_RENDERER)],
    ['A0 页面挂了点击并转成 open', () => /renderer\.enableClicks\(\)/.test(TOPO_VIEW)
      && /onNodeClick\s*=\s*\(\s*id\s*\)\s*=>\s*emit\(\s*'open'\s*,\s*id\s*\)/.test(TOPO_VIEW)],
    ['外壳把那个 open 接到 openDetail', () => /@open="openDetail"/.test(tagAttrs(APP, 'TopologyView') || '')],
    ['openDetail 写的就是 detail', () => /function openDetail\(hostId\)[\s\S]{0,240}?name:\s*'detail'/.test(APP)],
  ]
  const missing = LINKS.filter(([, test]) => !test()).map(([name]) => name)
  /* 反例：同一个"接到 openDetail"的判据去问 SettingsView——它确实不接（App.vue 里
     SettingsView 只吃 hosts，没有钻取），所以尺子必须对它报缺。 */
  const control = /@open="openDetail"/.test(tagAttrs(APP, 'SettingsView') || '')
  if (!CODE_INTACT) bad('A0→A1 链条四段齐', '尺子失效——剥注释后读不到锚点，下面的命中数不算读数')
  else if (control) bad('A0→A1 链条四段齐', '反例失效——同一条模式在 SettingsView 上也命中了，说明这条判据分不清谁接了 open')
  else if (missing.length) bad('A0→A1 链条四段齐', `断了 ${missing.length} 段：${missing.join(' / ')}`)
  else ok(`判据② 前半链条四段齐（${LINKS.map((l) => l[0]).join(' → ')}）：一次点击从机体落到 A1，中间没有第二跳（反例：同一条模式对 SettingsView 判为"未接"，尺子分得清谁有钻取口）`)
}

/* 一跳到位：状态机里能写 name:'detail' 的门只有 openDetail 一个。
   若有人再加一个门（比如"事件流点一下也进详情"），这条会红。 */
{
  const writers = hits(APP, /name:\s*'detail'/g).length
  const insideOpenDetail = /function openDetail\(hostId\)[\s\S]{0,240}?name:\s*'detail'/.test(APP)
  const reads = hits(APP, /route\.value\.(name|hostId|from)/g).length
  if (!CODE_INTACT) bad('进 A1 只有一扇门', '尺子失效——剥注释后读不到状态机锚点')
  else if (writers !== 1 || !insideOpenDetail) bad('进 A1 只有一扇门', `全 App.vue 里写 name:'detail' 的位置有 ${writers} 处（应为 1，且必须在 openDetail 内）——深度 1 的入口不止一个了`)
  else if (reads === 0) bad('进 A1 只有一扇门', '尺子失效——同一条扫描读不到任何 route.value 的读点，那个"1 处"不算数')
  else ok(`判据② 的"一次"：全 App.vue 只有 openDetail 一处写 name:'detail'（正对照：同一条扫描在 ${reads} 处读得到 route.value 的字段，尺子看得见这个状态机）`)
}

/* kiosk 的 interactive:false 是真的关掉了拾取：守卫必须在挂监听**之前**。
   反向改动=把守卫挪到 addEventListener 之后，或直接删守卫。 */
{
  const body = (A0_RENDERER.match(/enableClicks\(\)\s*\{[\s\S]*/) || [''])[0]
    .split('\n  /**')[0]
  const guardAt = body.search(/if\s*\(!this\.interactive\)\s*return/)
  const listenerAt = body.search(/addEventListener\(\s*'pointerdown'/)
  const onNodeClickAt = body.search(/this\.onNodeClick/)
  if (!CODE_INTACT) bad('kiosk 的 interactive:false 确实拿不到点击', '尺子失效——enableClicks 的函数体读不出来')
  else if (listenerAt < 0 || onNodeClickAt < 0) bad('kiosk 的 interactive:false 确实拿不到点击', `正对照失效——enableClicks 体内量不到 addEventListener('pointerdown')／onNodeClick，这条"守卫在前"无从比较`)
  else if (guardAt < 0) bad('kiosk 的 interactive:false 确实拿不到点击', '守卫没了：非交互实例现在也会挂上拾取监听')
  else if (guardAt > listenerAt) bad('kiosk 的 interactive:false 确实拿不到点击', `守卫在挂监听之后才 return（守卫@${guardAt} > 监听@${listenerAt}），interactive:false 不再拦住点击`)
  else ok(`判据② kiosk 侧的证据：enableClicks 体内 !this.interactive 的早退在 addEventListener('pointerdown') 之前（守卫@${guardAt} < 监听@${listenerAt}）——值守屏拿不到点击不是漏挂，是这条守卫（正对照：同一函数体内确有 pointerdown 监听与 onNodeClick 回调）`)
}

/* 深度 = 1（决策 6：禁嵌套、允许广度）。A1 不许再往外发 'open'。
   正对照：同一条模式在 A0／总览／接入三个组件上各命中一次。 */
{
  const detailEmits = (DETAIL_VIEW.match(/defineEmits\(\[([^\]]*)\]\)/) || [, ''])[1]
  const origins = (APP.match(/const ORIGINS\s*=\s*\[([^\]]*)\]/) || [, ''])[1]
      .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const breadth = ['views/TopologyView.vue', 'views/OverviewView.vue', 'views/EnrollView.vue']
      .filter((f) => /defineEmits\(\[[^\]]*'open'/.test(codeOf(f))).length
  const wrong = []
  if (/'open'/.test(detailEmits)) wrong.push(`DetailView 又往外发 'open' 了（defineEmits=[${detailEmits.trim()}]）——那是 A1→A2，决策 6 禁的是嵌套`)
  if (origins.includes('detail')) wrong.push(`ORIGINS 里混进了 'detail'：从详情页"返回"可以回到详情页，归位规则开始说谎`)
  if (!origins.includes('topology')) wrong.push(`ORIGINS 里没有 'topology'：从 A0 进详情、再返回，会掉回总览而不是陈列架`)
  if (breadth === 0) wrong.push(`尺子失效——A0／总览／接入里量不到任何发 'open' 的 defineEmits，那条"详情页不发 open"什么也没说`)
  if (!CODE_INTACT) wrong.push('尺子失效——剥注释后读不到 DetailView 的 defineEmits')
  if (wrong.length) bad('深度 = 1（禁 A1→A2）', wrong.join('; '))
  else ok(`判据② 的骨架边界：DetailView 只发 'back'（${detailEmits.trim() || '空'}）、ORIGINS=${origins.join('/')} 不含 detail（正对照：同一条模式在 ${breadth} 个同级页里量得到 'open'）——允许广度、禁止嵌套`)
}

/* =========================================================================
   B 组 · 判据② 后半：从 A1 回 A0 是不是"一次按键"
   ========================================================================= */

/* 回程一颗按钮、一个出口，并且它知道 A0 叫什么。 */
{
  const emitBacks = nOf(DETAIL_VIEW, /\$emit\(\s*'back'\s*\)/g)
  const wire = /@back="backFromDetail"/.test(tagAttrs(APP, 'DetailView') || '')
  const fromProp = /:from="route\.from"/.test(tagAttrs(APP, 'DetailView') || '')
  const backBody = (APP.match(/function backFromDetail\(\)\s*\{[\s\S]*?\n\}/) || [''])[0]
  const usesFrom = /route\.value\.from/.test(backBody) && /name:\s*to/.test(backBody)
  const mapsToA0 = /topology\s*:/.test((DETAIL_VIEW.match(/const BACK_TEXT\s*=\s*\{[^}]*\}/) || [''])[0])
  const label = ((DETAIL_VIEW.match(/topology:\s*'([^']*)'/) || [, '?'])[1])
  const wrong = []
  if (emitBacks !== 1) wrong.push(`DetailView 里 $emit('back') 有 ${emitBacks} 处（钉的是 1——出口只许有一条）`)
  if (!wire) wrong.push("App.vue 没把 DetailView 的 @back 接到 backFromDetail")
  if (!fromProp) wrong.push('DetailView 不再收 :from——返回按钮不知道自己是从哪一屏进来的')
  if (!usesFrom) wrong.push('backFromDetail 不再按 route.from 决定去哪儿——A1 的返回会硬编码到某一屏')
  if (!mapsToA0) wrong.push("BACK_TEXT 里没有 topology 这一支：从 A0 进的详情页，返回按钮说不出'回 A0'")
  if (wrong.length) bad('判据② 后半：回程一次点返回按钮', wrong.join('; '))
  else ok(`判据② 后半（点击口径）：A1 只有一颗返回出口（$emit('back') ×${emitBacks}）→ App 接 backFromDetail → 按 route.from 归位，且 BACK_TEXT 里 topology 这一支在（文案现值「${label}」，本轮不改文案）`)
}

/* "按键"的字面口径：A1 上没有任何键盘绑定。这条 0 命中是判据②后半**按字面不过**的
   证据，同时被正对照钉住（全仓唯一的键盘绑定在 HostCard 的改名输入框里）。 */
{
  const KEY_RE = /@keydown|@keyup|addEventListener\(\s*['"]key/gi
  const keySites = SRC_FILES.flatMap((f) => hits(codeOf(f), KEY_RE).map((m) => `${f}:${m[0]}`))
  const onA1 = keySites.filter((s) => /^views\/(?:DetailView|KioskView)\.vue/.test(s))
  const outsideRename = keySites.filter((s) => !s.startsWith('components/HostCard.vue'))
  const control = keySites.filter((s) => s.startsWith('components/HostCard.vue'))
  if (control.length === 0) bad('A1 上没有键盘出口（现状登记）', `正对照失效——同一条模式在全仓 ${SRC_FILES.length} 个源文件里一处键盘绑定也量不到，那个 0 不是读数`)
  else if (onA1.length || outsideRename.length) bad('A1 上没有键盘出口（现状登记）', `键盘绑定从 HostCard 改名框之外冒出来了：${(onA1.concat(outsideRename)).join(' / ')}——判据②后半的字面口径可能已经通了，这条要连判据文案一起改，别静默变绿`)
  else ok(`判据② 后半「一次按键」按字面**未过**（现状钉住）：全仓键盘绑定 ${keySites.length} 处全在 components/HostCard.vue 的改名输入框里，A1／kiosk／外壳 0 处 ⇒ 回程只有上面那条按钮路径，"一次按键回 A0"按字面不成立（正对照即这 ${control.length} 处：尺子看得见键盘）⇒ 补键盘出口属交互模型改动，交人裁`)
}

/* =========================================================================
   C 组 · 判据③：刷新／重开之后落在哪一屏，由谁决定
   ========================================================================= */

/* 视图与选中态一律不落地：整个客户端的存储读写只许有两个家，且都不是导航键。
   反向改动形状：`localStorage.setItem('hm-view', route.name)`。 */
{
  const STORE_RE = /\b(local|session)Storage\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*([^,)\s]+)/g
  const sites = []
  for (const f of SRC_FILES) {
    for (const m of hits(codeOf(f), STORE_RE)) {
      const store = m[1] + 'Storage'
      let key = m[3].replace(/^['"]|['"]$/g, '')
      if (/^[A-Z_]+$/.test(key)) {   // admin.js 走 const KEY = '...'
        const lit = codeOf(f).match(new RegExp(`const ${key}\\s*=\\s*'([^']+)'`))
        if (lit) key = lit[1]
      }
      sites.push(`${f}:${store}:${key}`)
    }
  }
  const NAVISH = sites.filter((s) => /view|route|host|kiosk|detail|selection|panel|screen/i.test(s.split(':').slice(2).join(':')))
  const ALLOWED = ['lib/admin.js:localStorage:hm.admin.pass', 'lib/sound.js:localStorage:hm-muted']
  const newKeys = sites.filter((s) => !ALLOWED.includes(s))
  /* 另一半：URL 也不许当导航态用。仓库里唯一合法的 URL 输入是 ?kiosk／?flat 这两个
     读点（App.vue 模块加载期读一次），没有任何写点。 */
  const urlWrites = []
  let urlReads = 0
  for (const f of SRC_FILES) {
    urlWrites.push(...hits(codeOf(f), /history\.(push|replace)State|location\.(hash|href)\s*=|indexedDB|document\.cookie\s*=/g).map((m) => `${f}:${m[0]}`))
    urlReads += nOf(codeOf(f), /location\.search|new URLSearchParams\(/g)
  }
  const wrong = []
  if (sites.length < 2) wrong.push(`尺子失效——${SRC_FILES.length} 个源文件里只量到 ${sites.length} 处存储读写，那条"没有第三家"不算读数（正对照应至少含 口令／静音 两家）`)
  if (NAVISH.length) wrong.push(`有存储键像是在持久化视图或选中态：${NAVISH.join(' / ')}——判据③ 要的正是"刷新之后由代码决定落哪一屏"，不是由上次离开时决定`)
  if (newKeys.length) wrong.push(`冒出清单之外的存储家：${newKeys.join(' / ')}（清单：${ALLOWED.join(' / ')}）`)
  if (urlWrites.length) wrong.push(`URL 开始承载导航态（写点 ${urlWrites.length} 处：${urlWrites.join(' / ')}）——"刷新之后"从此由地址栏决定`)
  if (urlReads === 0) wrong.push('尺子失效——全仓量不到任何 location.search／URLSearchParams 的读点，那条"URL 侧没有导航写点"什么也没说')
  if (wrong.length) bad('视图／选中态零持久化', wrong.join('; '))
  else ok(`判据③ 的那一半**通**且被钉住：视图态与选中 host 不落任何存储——${SRC_FILES.length} 个源文件里存储读写共 ${sites.length} 处、键只有 ${ALLOWED.map((s) => s.split(':').pop()).join(' / ')}（都不是导航键），URL 侧导航写点 0 处（正对照：同一条扫描量到 ${urlReads} 处 URL 读点＝?kiosk／?flat）`)
}

/* 新载入落在哪一屏：只许由 App.vue 那一行 ref 的字面量决定，本轮钉住现状值。 */
{
  const initMatch = APP.match(/const route = ref\(\{([\s\S]*?)\}\)/)
  const init = initMatch ? initMatch[1] : null
  const nameLit = init && (init.match(/name:\s*'([^']*)'/) || [])[1]
  const wantsStorage = init && /(Storage|params|location|getItem|URLSearchParams)/.test(init)
  const openLit = (APP.match(/function openDetail\(hostId\)[\s\S]{0,240}?name:\s*'([^']*)'/) || [])[1]
  const WANT = 'overview'   // 09-22 实测的现值；钉它不是判它对了
  const wrong = []
  if (!CODE_INTACT) wrong.push('尺子失效——剥注释后读不到状态机锚点')
  if (!init) wrong.push('App.vue 里读不到 `const route = ref({...})` 这一行——默认屏不再由一处决定，判据③ 失去可核对的落点')
  else if (wantsStorage) wrong.push(`默认屏的初值开始读存储／URL（${init.trim().replace(/\s+/g, ' ')}）——"刷新之后必是陈列架"变成"刷新之后必是上次那一屏"`)
  else if (openLit !== 'detail') wrong.push(`尺子失效——同一条抽取在 openDetail 里没读到 name:'detail'（实读 ${openLit}），那条初值读数不算数`)
  else if (nameLit !== WANT) wrong.push(`新载入默认屏从「${WANT}」变成了「${nameLit}」。两种可能：① 有人按判据③ 把它改成陈列架（那是交互模型改动，交人裁过没有？）② 顺手改的。无论哪种，这条与它上面那句结论都要连字面一起改，不许静默变绿`)
  if (wrong.length) bad('默认落地屏只有一个字面量', wrong.join('; '))
  else ok(`判据③ 的另一半：新载入落哪一屏由 App.vue 里唯一一个初值决定（name:'${nameLit}'，且不读存储／URL；同一条抽取在 openDetail 处读到的是 '${openLit}'，尺子看得见这两个字面量）——⚠️ 现值 'overview' 是「总览」＝T0 台账表，**不是 A0 陈列架**，故判据③ 在非 kiosk 路径上按任务书口径未过，登记交人裁（决策 6 写的是"A0 默认态，也是唯一常态"）`)
}

/* kiosk 那一侧：墙由 URL 上的一个 flag 决定，降级模式不许跨过刷新。
   反向改动形状：把 mode 写进 localStorage，一次掉帧就永久改变墙的样子。 */
{
  const kioskFlag = /const kiosk = params\.has\('kiosk'\)/.test(APP)
  const branch = /<KioskView\b/.test(APP) && /v-if="kiosk"/.test((APP.match(/<KioskView\b[^>]*>/) || [''])[0])
  const modeInit = (KIOSK_VIEW.match(/const mode = ref\(([\s\S]*?)\)/) || [''])[0]
  const modeFromPropOnly = /props\.forceFlat\s*\?\s*'flat'\s*:\s*'scene'/.test(modeInit)
  const modePersisted = /(Storage|getItem|setItem)/.test(modeInit)
  const wrong = []
  if (!kioskFlag || !branch) wrong.push("App.vue 的 ?kiosk 分支不是一处 query flag（判据③ 在墙上这一路的依据没了）")
  if (!modeFromPropOnly) wrong.push(`KioskView 的 mode 初值不再是"只看 ?flat=1"（实读 ${modeInit.trim().replace(/\s+/g, ' ') || '读不到'}）——3D／平面这一档不再每次载入重新决定`)
  if (modePersisted) wrong.push('mode 开始读存储：一次降级会永久留在墙上，刷新不再"必是陈列架"')
  if (wrong.length) bad('kiosk 刷新必回 3D 陈列架', wrong.join('; '))
  else ok(`判据③ 在墙上这一路**通**：?kiosk 决定渲染 KioskView（App.vue 一处 query flag，模块加载期读一次），降级 mode 每次载入只由 ?flat=1 重新决定（正对照：初值里确实只读 props.forceFlat → 'flat'／'scene'）——一次掉帧不会跨过刷新`)
}

/* 墙上没有钻取入口（S4 §2.5「值守屏无钻取」）——这是判据② 在 kiosk 上**断**的证据，
   钉现状用。它变红＝有人改了交互模型，那是交人裁的事，不是改这条判据的理由。 */
{
  const kioskClicks = nOf(KIOSK_VIEW, /enableClicks|onNodeClick/g)
  const kioskNonInteractive = /interactive:\s*false/.test(KIOSK_VIEW)
  const kioskBranch = APP.slice(APP.search(/<KioskView\b/), APP.search(/<template v-else>/))
  const detailInKioskBranch = /DetailView\b/.test(kioskBranch)
  const control = nOf(TOPO_VIEW, /enableClicks|onNodeClick/g)
  const controlDetail = nOf(APP, /<DetailView\b/g)
  const wrong = []
  if (control === 0) wrong.push('正对照失效——同一条模式在 A0 页面上量不到 enableClicks／onNodeClick，那个 0 不是读数')
  if (controlDetail === 0) wrong.push('尺子失效——App.vue 里反而读不到 <DetailView 的挂载点')
  if (kioskClicks !== 0) wrong.push(`KioskView 里出现 ${kioskClicks} 处 enableClicks／onNodeClick——墙上有了钻取入口，与 S4 §2.5「值守屏无钻取」冲突：这是交互模型改动，判据② 的这条现状与它的裁定要一起改`)
  if (!kioskNonInteractive) wrong.push('KioskView 不再传 interactive:false——A0 渲染器的点击守卫在值守屏上失效了')
  if (detailInKioskBranch) wrong.push('?kiosk 分支里挂上了 DetailView：kiosk 路径开始能进 A1（同上，交人裁）')
  if (wrong.length) bad('墙上没有钻取入口（现状登记）', wrong.join('; '))
  else ok(`判据② 在 kiosk 路径上**断**（现状钉住，非本轮修法）：KioskView 里 enableClicks／onNodeClick 0 处且传 interactive:false，?kiosk 分支不渲染 DetailView ⇒ 刷新必是陈列架成立、一次点击进 A1 不成立（正对照：同一条模式在 TopologyView 命中 ${control} 处、App.vue 里 <DetailView 挂载点 ${controlDetail} 处）——要通这一条得改 S4 §2.5，交人裁`)
}

/* 陈列架在两条路上都到得了：非 kiosk 经顶栏那一格「拓扑」，且顶栏只画四格。 */
{
  const toggleTab = /\$emit\('toggle',\s*'topology'\)/.test(CLUSTER_BAR)
  const wired = /@toggle="setView"/.test(tagAttrs(APP, 'ClusterBar') || '')
  const setViewBody = (APP.match(/function setView\(name\)\s*\{[\s\S]*?\n\}/) || [''])[0]
  const writesName = /name,/.test(setViewBody) || /name:\s*name/.test(setViewBody)
  const tabs = nOf(CLUSTER_BAR, /\$emit\('toggle',\s*'[a-z]+'\)/g)
  const wrong = []
  if (!toggleTab) wrong.push("顶栏里没有「拓扑」那一格（$emit('toggle','topology') 不见了）——非 kiosk 路径到不了陈列架")
  if (!wired) wrong.push('App.vue 没把 ClusterBar 的 @toggle 接到 setView')
  if (!writesName) wrong.push('setView 不再用传进来的名字写 route——顶栏那一格说了不算')
  if (tabs < 4) wrong.push(`尺子失效——顶栏只量到 ${tabs} 个 toggle 目标，那条"拓扑那一格在"不算读数`)
  if (wrong.length) bad('陈列架在非 kiosk 下由顶栏一格可达', wrong.join('; '))
  else ok(`判据③ 的可达性半边：顶栏 ${tabs} 处 toggle 目标（4 个 tab ＋ 道具／未带凭据两个徽标，它们指向接入页）里有一格明确 $emit('toggle','topology') → App 的 @toggle 交给 setView 写进 route.name（非 kiosk 下 A0 不是删不掉的孤岛，但也不是落地屏——见上面那条登记）`)
}

/* route 这个状态机只有一个家：整体赋值恰好 3 处（进详情／切屏／返回），不许有人
   在别处逐字段改它。反向改动形状：某组件里 `route.value.name = 'topology'`。 */
{
  const whole = nOf(APP, /route\.value\s*=[^=]/g)
  const fieldWise = nOf(APP, /route\.value\.(name|hostId|from)\s*=[^=]/g)
  const writers = ['function openDetail', 'function setView', 'function backFromDetail']
    .filter((f) => APP.includes(f))
  const reads = nOf(APP, /route\.value\./g)
  const wrong = []
  if (!CODE_INTACT) wrong.push('尺子失效——剥注释后读不到状态机函数头')
  if (writers.length !== 3) wrong.push(`三个归位函数读不齐（实读 ${writers.join('/') || '无'}）——判据按"进／切／回各一处"来，函数没了这条就得重画`)
  if (whole !== 3) wrong.push(`route.value 的整体赋值有 ${whole} 处（钉的是 3＝openDetail／setView／backFromDetail）——导航状态多了写主`)
  if (fieldWise) wrong.push(`出现逐字段改 route 的写法 ${fieldWise} 处：整体赋值那一处一家不再成立，from 会被改出来说谎`)
  if (reads === 0) wrong.push('尺子失效——读不到任何 route.value 的读点，那个"3 处"不算数')
  if (wrong.length) bad('导航状态机只有一个家', wrong.join('; '))
  else ok(`判据②③ 的落点唯一：route.value 整体赋值恰 ${whole} 处（${writers.map((w) => w.replace('function ', '')).join(' / ')}），逐字段改写 0 处（正对照：同一条扫描在 ${reads} 处读得到 route.value 的字段）`)
}

/* =========================================================================
   结论（本轮实测，逐环开过行号；改判必须连本文件上面的判据一起改）
   =========================================================================
   · 判据②  非 kiosk：通（拾取 → emit('open') → @open="openDetail" → name:'detail'，
              四段各一处；回程一颗 $emit('back') 按 from 归位）。
              ⚠️ 字面口径"一次**按键**"未通：A1 上没有键盘绑定。
   · 判据②  kiosk（?kiosk，也就是客厅那面墙实际跑的那一路）：**断**。
              KioskView 传 interactive:false、不调 enableClicks、不挂 DetailView，
              依据是 S4 §2.5「值守屏无钻取」。这一条与竖切判据②正面冲突 ⇒ 交人裁。
   · 判据③  「视图／选中态不持久化」：通，且是 A0 之后第一次被钉住。
              新载入落哪一屏由 App.vue 里唯一一个 name 字面量决定 ⇒ 现值 'overview'
              （总览＝T0 台账表），不是 A0 ⇒ 判据③ 在非 kiosk 路径上**未过**。
              kiosk 那一路：?kiosk 是 URL flag，刷新必回墙 ⇒ 通。
   · 以上三处"断"全在交互模型上，本包一律**只登记不修**（任务书 B §5 该问再碰那一档）。
   · 视觉与真机手感：**未验证，交人眼看一次**。
   ========================================================================= */

console.log(`\n[selftest-nav] pass=${pass} fail=${failures.length}`)
process.exit(failures.length ? 1 : 0)
