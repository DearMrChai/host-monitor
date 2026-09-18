"""
Star probe engine (P3)
======================
Periodically probes Server / gateway / key nodes and keeps a sliding
loss+RTT window per target. Results ride along in every metrics frame
under the "probes" key.

Methods (in order of preference):
  - ws:    WebSocket ping/pong over the existing Server connection.
           Zero firewall dependency; used for the Server target.
  - icmp:  system `ping` (no admin rights needed), en/zh output parsing.
  - tcp:   TCP handshake RTT as ICMP fallback. Connection-refused still
           proves the host is alive (an RST came back).

Outcome classes per probe (P3 design 1.3):
  OK    -> rtt recorded
  FAIL  -> counts as loss (host confirmed unreachable on all usable methods)
  IND   -> method indeterminate (ICMP blocked, no configured TCP port):
           records NOTHING, so a restricted network never false-alarms.
"""
import asyncio
import collections
import platform
import re
import statistics
import time

IS_WINDOWS = platform.system() == "Windows"

# "time=1ms" / "time<1ms" / "时间=1ms" / "时间<1ms"
_RTT_RE = re.compile(r"(?:time|时间)\s*[=<]\s*([\d.]+)\s*ms", re.IGNORECASE)
# "Reply from ..." / "来自 ... 的回复"
_REPLY_RE = re.compile(r"(?:reply from|来自)", re.IGNORECASE)

OK, FAIL, IND = "ok", "fail", "ind"


class _Window:
    """Sliding window of probe outcomes -> (rtt_ms median, loss_pct)."""

    def __init__(self, size):
        self._d = collections.deque(maxlen=size)

    def add(self, outcome, kind, rtt_ms=None):
        self._d.append((outcome, kind, rtt_ms))

    def snapshot(self):
        if not self._d:
            return None
        failed = sum(1 for o, _, _ in self._d if o == FAIL)
        rtts = [r for o, _, r in self._d if o == OK and r is not None]
        last_ok_kind = next((k for o, k, _ in reversed(self._d) if o == OK), None)
        return {
            "kind": last_ok_kind or self._d[-1][1],
            "rtt_ms": round(statistics.median(rtts), 1) if rtts else None,
            "loss_pct": round(failed * 100 / len(self._d)),
        }


class Prober:
    def __init__(self, ws_ref):
        self._ws_ref = ws_ref            # {"ws": connection | None}
        self._interval = 5.0
        self._size = 10
        self._targets = [{"id": "server", "name": "Server", "method": "ws", "host": None}]
        self._windows = {"server": _Window(self._size)}
        self._task = None

    # ---------- plan from Server (probe_plan in `registered` ack) ----------

    def apply_plan(self, plan):
        if not plan:
            return
        self._interval = plan.get("probe_interval_seconds", self._interval)
        self._size = plan.get("window_size", self._size)
        targets = [{"id": "server", "name": "Server", "method": "ws", "host": None}]
        gw = plan.get("gateway")
        if gw and gw.get("host"):
            targets.append({"id": "gateway", "name": gw.get("name") or "网关",
                            "method": "icmp", "host": gw["host"],
                            "tcp_port": gw.get("tcp_port")})
        for kh in plan.get("key_hosts") or []:
            if kh.get("host"):
                targets.append({"id": kh.get("id") or kh["host"],
                                "name": kh.get("name") or kh["id"] or kh["host"],
                                "method": "icmp", "host": kh["host"],
                                "tcp_port": kh.get("tcp_port")})
        self._targets = targets
        windows = {}
        for t in targets:
            old = self._windows.get(t["id"])
            windows[t["id"]] = old if (old and old._d.maxlen == self._size) else _Window(self._size)
        self._windows = windows

    # ---------- lifecycle ----------

    def start(self):
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def _loop(self):
        while True:
            # stagger targets so a slow ping never delays the others
            for t in self._targets:
                outcome, kind, rtt = await self._probe(t)
                if outcome != IND:
                    self._windows[t["id"]].add(outcome, kind, rtt)
                await asyncio.sleep(0.05)
            await asyncio.sleep(self._interval)

    def reset_target(self, target_id):
        """Clear a window (e.g. after reconnect: the offline period is
        reported as node OFFLINE, not as a lingering server-link alert)."""
        if target_id in self._windows:
            self._windows[target_id] = _Window(self._size)

    def snapshot(self):
        results = []
        for t in self._targets:
            s = self._windows[t["id"]].snapshot()
            if s:
                results.append({"target": t["id"], "name": t["name"], **s})
        return {"interval_s": self._interval, "window": self._size, "results": results}

    # ---------- methods ----------

    async def _probe(self, t):
        if t["method"] == "ws":
            return await self._probe_ws()
        outcome, rtt = await self._probe_icmp(t["host"])
        if outcome == OK:
            return OK, "icmp", rtt
        if outcome == IND and t.get("tcp_port"):
            o2, r2 = await self._probe_tcp(t["host"], t["tcp_port"])
            if o2 != IND:
                return o2, "tcp", r2
        if outcome == FAIL:
            return FAIL, "icmp", None
        return IND, "icmp", None

    async def _probe_ws(self):
        ws = self._ws_ref.get("ws")
        if ws is None:
            return FAIL, "ws", None  # disconnected: server arm is genuinely down
        try:
            t0 = time.perf_counter()
            pong = await ws.ping()
            await asyncio.wait_for(pong, timeout=2)
            return OK, "ws", round((time.perf_counter() - t0) * 1000, 2)
        except Exception:
            return FAIL, "ws", None

    async def _probe_icmp(self, host):
        cmd = (["ping", "-n", "1", "-w", "1000", host] if IS_WINDOWS
               else ["ping", "-c", "1", "-W", "1", host])
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        except OSError:
            return IND, None  # ping binary unavailable: method unsupported
        try:
            out = (await asyncio.wait_for(proc.communicate(), timeout=3))[0]
        except asyncio.TimeoutError:
            proc.kill()
            return IND, None  # hung: inconclusive, do not count
        text = out.decode(errors="replace")
        if _REPLY_RE.search(text):
            m = _RTT_RE.search(text)
            return OK, float(m.group(1)) if m else None
        # No reply: unreachable vs ICMP-blocked is indistinguishable here.
        # "Request timed out" alone => blocked/filtered (IND, TCP may tell more);
        # "unreachable / could not find host" => definitive FAIL.
        if re.search(r"unreachable|无法访问|找不到主机|general failure", text, re.IGNORECASE):
            return FAIL, None
        return IND, None

    async def _probe_tcp(self, host, port):
        t0 = time.perf_counter()
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=2)
            rtt = round((time.perf_counter() - t0) * 1000, 1)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return OK, rtt
        except ConnectionRefusedError:
            return OK, None  # host answered with RST => alive (rtt unknown)
        except asyncio.TimeoutError:
            return IND, None  # timeout: filtered port or down -> not decisive
        except OSError:
            return FAIL, None  # unreachable/host errors: decisive
