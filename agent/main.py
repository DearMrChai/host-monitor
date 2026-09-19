"""
Host Monitor Agent
==================
Collects hardware metrics + topology and pushes to central server via WebSocket.

Usage:
    python main.py                                  # read agent.json / env
    python main.py --enroll 3f9a2c81d4e7            # pair once, then stream
    python main.py --print-config                   # what am I actually using

Settings resolve CLI > env (HM_SERVER/HM_HOST_ID/HM_INTERVAL/HM_ROLE/HM_TOKEN)
> agent.json > default - see config.py. Pairing writes identity.json (host_id +
the node key the Server minted), so the second start needs no code.
"""
import argparse
import asyncio
import json
import platform
import socket
import sys
import time

import websockets

import config
from collectors import cpu, disk, gpu, memory, network, system
from collectors.topology import detect_topology
from prober import Prober

# Console encoding is a real failure mode on this fleet, not a cosmetic one:
# 231 runs an LTSC/GBK console, and the refusal text below is Chinese. Pinning
# UTF-8 with replacement means a print can never take the agent down (the ICMP
# parser bit us the same way in P4).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

ROLES = config.ROLES

# Server-side ingest reasons (server/src/ingest.js REASON_TEXT) translated at
# the point of use: the person holding a pairing code reads Chinese, and "why
# didn't my machine show up" is exactly the question this answers.
REASON_CN = {
    "no_host_id": "帧未带 host_id",
    "no_code": "未带配对码",
    "unknown_code": "配对码不存在（是不是抄错了，或已被撤销）",
    "code_expired": "配对码已过期，请在看板上重新生成一个",
    "code_used_up": "配对码次数已用完，请在看板上重新生成一个",
    "unknown_host": "服务器不认识这台机器，且未带有效配对码",
    "bad_key": "本机保存的节点密钥已失效，需要重新配对",
    "host_mismatch": "metrics 帧与连接注册的节点不一致",
}

EXIT_DENIED = 2

# S6 §4 (H6): the Server names which plan it handed out, and this box is the one
# place an operator can ask "why is it pinging that gateway". Without the source
# the same log line reads identically for a plan that is right and a plan that
# was inherited from another site.
PLAN_SOURCE_CN = {
    "node": "该机专属",
    "site": "站点计划",
    "global": "全局计划（未按站点区分）",
    "none": "服务器未下发计划",
}


class Denied(Exception):
    """The server turned this connection away on purpose. Retrying in a loop
    would only bury the reason - the operator has to see it and act."""


def collect_all(host_id):
    """Run all collectors and assemble a full metrics frame."""
    frame = {
        "host_id": host_id,
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "timestamp": int(time.time() * 1000),
        "cpu": cpu.collect(),
        "gpu": gpu.collect(),
        "memory": memory.collect(),
        "network": network.collect(),
        "disk": disk.collect(),
        "system": system.collect(),
    }
    return frame


def register_frame(cfg, topo, token, fingerprint):
    return {
        "type": "register",
        "host_id": cfg.host_id,
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "role": cfg.role,
        "topology": topo,
        # H2/H4: the Server can now show which box runs which agent build, and
        # trip the fingerprint-drift wire when host_id X arrives from new hardware.
        "agent_version": config.AGENT_VERSION,
        "fingerprint": fingerprint,
        "token": token,
    }


async def run_agent(cfg, interval, pair_only=False):
    """Main agent loop: connect, register, then stream metrics."""
    fingerprint, fp_source = config.machine_fingerprint(cfg.data_dir)
    token = cfg.enroll_code or cfg.token or cfg.node_key
    via = ("pairing code" if cfg.enroll_code
           else "HM_TOKEN" if cfg.sources.get("token") == "env HM_TOKEN"
           else "identity.json" if token else "none (legacy grace)")
    print(f"[Agent] Host ID:  {cfg.host_id}")
    print(f"[Agent] Server:   {cfg.server}")
    print(f"[Agent] Interval: {interval}s")
    print(f"[Agent] Version:  {config.AGENT_VERSION}   fingerprint: {fp_source}/{fingerprint[:8]}…")
    print(f"[Agent] Credential: {via}")

    # Detect hardware topology once at startup
    print(f"[Agent] Detecting hardware topology...")
    topo = detect_topology()
    print(f"[Agent] Topology: {topo['cpu']['model']}, "
          f"{len(topo['memory']['sticks'])} DIMM, "
          f"{len(topo['gpu'])} GPU, "
          f"{len(topo['storage'])} Storage")

    print(f"[Agent] Connecting...")

    ws_ref = {"ws": None}           # shared with prober: current connection or None
    prober = Prober(ws_ref)

    while True:
        try:
            async with websockets.connect(cfg.server) as ws:
                ws_ref["ws"] = ws
                prober.reset_target("server")  # fresh window after (re)connect
                print(f"[Agent] Connected to {cfg.server}")

                # Send registration with topology
                await ws.send(json.dumps(register_frame(cfg, topo, token, fingerprint)))

                # The ack either carries the node key (we just paired), the probe
                # plan (P3), or a refusal with a reason. Old servers that send
                # nothing just leave us probing the Server arm only.
                try:
                    ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                except (asyncio.TimeoutError, json.JSONDecodeError) as e:
                    print(f"[Agent] No registration reply ({e}); server-only probing")
                    ack = {}
                if ack.get("type") == "rejected":
                    reason = ack.get("reason") or "unknown"
                    raise Denied(reason)
                if ack.get("node_key"):
                    # Identity and key must travel together, or the next start
                    # would present this key under a different host_id and be refused.
                    config.save_identity(
                        cfg.data_dir, host_id=cfg.host_id, node_key=ack["node_key"],
                        server=cfg.server, fingerprint=fingerprint,
                        paired_at=int(time.time() * 1000), agent_version=config.AGENT_VERSION,
                    )
                    print(f"[Agent] Paired. Node key saved to "
                          f"{config.path_of(cfg.data_dir, config.IDENTITY_FILE)}")
                    cfg.enroll_code = None    # spend it once, never again
                plan = ack.get("probe_plan")
                prober.apply_plan(plan)
                src = ack.get("probe_plan_source")
                src_text = PLAN_SOURCE_CN.get(src, src)
                if plan:
                    print(f"[Agent] Probe plan: "
                          f"{', '.join(t['id'] for t in prober._targets)}"
                          + (f"  [来源 {src_text}]" if src_text else ""))
                elif src == "none":
                    # Say it out loud: "no gateway arm" because the Server has no
                    # plan is a different fact from an old Server that sent no ack
                    # at all (that case prints nothing here).
                    print(f"[Agent] {src_text}，只探 Server 臂")
                if pair_only:
                    # The prober has not started yet, so leaving the `async with`
                    # is the whole shutdown; --pair-only exists for installers
                    # that pair first and let the scheduled task do the running.
                    print("[Agent] --pair-only: registered, exiting.")
                    return
                prober.start()

                # Stream metrics (probe results ride along)
                while True:
                    frame = collect_all(cfg.host_id)
                    frame["type"] = "metrics"
                    frame["probes"] = prober.snapshot()
                    await ws.send(json.dumps(frame))
                    await asyncio.sleep(interval)

        except Denied as e:
            print(f"[Agent] 服务器拒绝接入：{REASON_CN.get(e.args[0], e.args[0])}")
            print("[Agent] 解决后重新启动即可（本机不会反复重试，以免刷日志）。")
            return EXIT_DENIED

        except (websockets.exceptions.ConnectionClosed, ConnectionRefusedError, OSError) as e:
            ws_ref["ws"] = None
            print(f"[Agent] Connection lost: {e}. Retrying in 5s...")
            await asyncio.sleep(5)
        except Exception as e:
            ws_ref["ws"] = None
            print(f"[Agent] Error: {e}. Retrying in 5s...")
            await asyncio.sleep(5)


ARGS = None


def main():
    global ARGS
    parser = argparse.ArgumentParser(description="Host Monitor Agent")
    # Every option is also settable in agent.json / env (config.py). The flags
    # remain because the three deployed boxes already pass them, and mid-
    # iteration we must not break the ones nobody re-writes today.
    parser.add_argument("--server", default=None,
                        help="WebSocket server URL (default/env: ws://host:9100)")
    parser.add_argument("--interval", type=float, default=None,
                        help="Collection interval in seconds")
    parser.add_argument("--host-id", default=None,
                        help="Custom host identifier")
    parser.add_argument("--role", default=None, choices=ROLES,
                        help="Node role tag (affects overview ordering)")
    parser.add_argument("--enroll", default=None, metavar="CODE",
                        help="One-time pairing code from the dashboard; the node "
                             "key it buys is saved to identity.json")
    parser.add_argument("--pair-only", action="store_true",
                        help="Register, save the key, then exit without streaming")
    parser.add_argument("--data-dir", default=None,
                        help="Where agent.json / identity.json live (default: this folder)")
    parser.add_argument("--print-config", action="store_true",
                        help="Show the resolved settings and where each came from")
    ARGS = parser.parse_args()

    # argparse hands us None for anything not typed - exactly the signal
    # config.resolve() needs so that a flag-free start does not outrank env/file.
    cli = {
        "server": ARGS.server, "interval": ARGS.interval,
        "host_id": ARGS.host_id, "role": ARGS.role, "token": None,
    }
    cfg = config.resolve(cli, data_dir=ARGS.data_dir)
    cfg.enroll_code = ARGS.enroll
    if ARGS.print_config:
        print(f"[Agent] data dir: {cfg.data_dir}")
        print(cfg.describe())
        print(f"  credential= {'identity.json' if cfg.node_key else 'none'}")
        return 0

    code = 0
    try:
        code = asyncio.run(run_agent(cfg, cfg.interval, pair_only=ARGS.pair_only)) or 0
    except KeyboardInterrupt:
        print("\n[Agent] Stopped.")
    finally:
        gpu.shutdown()
    return code


if __name__ == "__main__":
    sys.exit(main())
