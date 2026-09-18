"""
P3 Step-0 feasibility probe (not a deliverable; diagnostic only).

Answers product-plan 1.4 open question: which probe methods actually work on
this LAN? Tests ICMP (subprocess ping, counting reply lines + RTT parsing to
verify locale-robust regex) and TCP connect RTT against the fleet targets.

Usage: python probe-selftest.py
"""
import platform
import re
import socket
import subprocess
import sys
import time

IS_WINDOWS = platform.system() == "Windows"

# Fill in your own LAN addresses before running (kept out of git on purpose)
ICMP_TARGETS = [
    ("gateway", "192.168.1.1"),
    ("key-host-A", "192.168.1.2"),
    ("server-host", "192.168.1.3"),
]

TCP_TARGETS = [
    ("key-host-A ssh", "192.168.1.2", 22),
    ("server-host ssh", "192.168.1.3", 22),
    ("gateway http", "192.168.1.1", 80),
]

# same regex the Agent prober will use: covers en + zh ping output, time= / time< / 时间=
RTT_RE = re.compile(r"(?:time|\u65f6\u95f4)\s*[=<]\s*([\d.]+)\s*ms", re.IGNORECASE)
REPLY_RE = re.compile(r"(?:reply from|\u6765\u81ea)", re.IGNORECASE)


def icmp_ping(host, count=4):
    cmd = (["ping", "-n", str(count), "-w", "1000", host] if IS_WINDOWS
           else ["ping", "-c", str(count), "-W", "1", host])
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              encoding=None, errors="replace", timeout=count + 6)
        out = proc.stdout + proc.stderr
    except subprocess.TimeoutExpired:
        return {"reachable": 0, "count": count, "rtt": [], "err": "subprocess timeout"}
    elapsed_ms = round((time.time() - t0) * 1000)
    replies = len(REPLY_RE.findall(out))
    rtts = [float(m) for m in RTT_RE.findall(out)]
    return {"reachable": replies, "count": count, "rtt": rtts,
            "exit": proc.returncode, "elapsed_ms": elapsed_ms,
            "sample": out.strip().splitlines()[-1] if out.strip() else ""}


def tcp_probe(host, port, timeout=1.0, tries=3):
    rtts, fails = [], []
    for _ in range(tries):
        t0 = time.time()
        try:
            with socket.create_connection((host, port), timeout=timeout):
                rtts.append(round((time.time() - t0) * 1000, 1))
        except Exception as e:
            fails.append(type(e).__name__)
        time.sleep(0.2)
    return {"ok": len(rtts), "tries": tries, "rtt": rtts, "fails": fails}


def main():
    print(f"platform={platform.system()} python={sys.version.split()[0]}\n")
    print("== ICMP ==")
    for name, ip in ICMP_TARGETS:
        r = icmp_ping(ip)
        print(f"{name:10s} {ip:15s} replies={r['reachable']}/{r['count']} "
              f"rtt={r['rtt']} {r.get('err', '')}")
        if r.get("sample"):
            print(f"           last-line: {r['sample'][:120]}")
    print("\n== TCP connect ==")
    for name, ip, port in TCP_TARGETS:
        r = tcp_probe(ip, port)
        print(f"{name:10s} {ip}:{port:<5d} ok={r['ok']}/{r['tries']} rtt_ms={r['rtt']} fails={r['fails']}")


if __name__ == "__main__":
    main()
