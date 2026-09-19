// strict 档的现场负例：不在名册里的 host_id 不带凭据必须被拒（H8 的可证伪面）。
// 每次里程碑重部署后跑一次，代替"看一眼配置就说生效了"。
//   node scripts/probe-strict-denial.mjs ws://<server>:9100 [host_id]
// 地址不写死在这里：真实内网 IP 不进仓库。
import { WebSocket } from 'ws';

const url = process.argv[2];
if (!url || !/^wss?:\/\//.test(url)) {
  console.error('usage: node scripts/probe-strict-denial.mjs ws://<server>:9100 [host_id]');
  process.exit(1);
}
const hostId = process.argv[3] || 'neg-test-strict';
const ws = new WebSocket(url);
const t = setTimeout(() => { console.log('TIMEOUT no reply'); process.exit(2); }, 8000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', host_id: hostId, hostname: 'neg-test', role: 'other' }));
});
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  console.log('REPLY:', JSON.stringify({ type: m.type, ok: m.ok, reason: m.reason }));
  clearTimeout(t);
  ws.close();
  process.exit(m.type === 'rejected' ? 0 : 3);   // 0 = 门禁如预期挡住了
});
ws.on('error', (e) => { console.log('WS_ERROR', e.message); process.exit(1); });
ws.on('close', (code, reason) => { console.log('CLOSE', code, String(reason || '')); });
