"""
S2b config + identity self-test (pure Python, no Server needed).

    python agent/scripts/config-selftest.py

Covers the parts that would otherwise be discovered on a friend's machine at
demo time: which layer wins, what happens to a hand-mangled agent.json, and
whether a paired box keeps reporting as itself after its hostname changes.
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402

pass_ = fail = 0


def ok(name, cond, got=None):
    global pass_, fail
    if cond:
        pass_ += 1
        print(f"PASS  {name}" + (f"   {got}" if got else ""))
    else:
        fail += 1
        print(f"FAIL  {name}   got={got!r}")


def write(d, name, obj):
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


D = tempfile.mkdtemp(prefix="hm-agent-cfg-")


def resolve(cli=None, data_dir=D, env=None):
    """Pass an explicit env dict so a stray HM_* in the developer's shell cannot
    change what this test proves (and so the test can set one on purpose)."""
    return config.resolve(cli or {}, data_dir=data_dir, env=env or {})


try:
    # ---------- precedence ----------
    c = resolve()
    ok("C1 无配置可退：默认值 + host_id 由主机名推导",
       c.server == "ws://localhost:9100" and c.interval == 2.0 and c.role == "other"
       and bool(c.host_id) and c.sources["host_id"] == "hostname",
       f"{c.host_id}<-{c.sources['host_id']}")

    write(D, config.CONFIG_FILE,
          {"server": "ws://192.0.2.9:9100", "interval": 5, "role": "db"})
    c = resolve()
    ok("C2 agent.json 生效（H2：不再需要把参数烧进计划任务）",
       c.server == "ws://192.0.2.9:9100" and c.interval == 5.0 and c.role == "db",
       c.sources["server"])

    c = resolve(env={"HM_INTERVAL": "7", "HM_ROLE": "laptop"})
    ok("C3 环境变量压过文件", c.interval == 7.0 and c.role == "laptop",
       c.sources["interval"])

    c = resolve({"interval": 3.0}, env={"HM_INTERVAL": "7", "HM_ROLE": "laptop"})
    ok("C4 命令行压过环境（且只有真写了的参数才算数）",
       c.interval == 3.0 and c.role == "laptop", c.sources["interval"])

    # ---------- bad input degrades instead of crashing ----------
    write(D, config.CONFIG_FILE,
          {"server": "192.0.2.9:9100", "interval": "abc", "role": "banana"})
    c = resolve()
    ok("C5 漏了 ws:// / interval 非数字 / role 不认识：退回默认并说明，而不是崩",
       c.server == "ws://localhost:9100" and c.interval == 2.0 and c.role == "other")

    write(D, config.CONFIG_FILE, {"interval": 99999, "role": "DB"})
    c = resolve()
    ok("C5b 荒谬的 interval 被拦；大小写不影响合法 role",
       c.interval == 2.0 and c.role == "db", f"{c.interval}/{c.role}")

    with open(os.path.join(D, config.CONFIG_FILE), "w", encoding="utf-8") as f:
        f.write("{ this is not json")
    c = resolve()
    ok("C6 手改坏的配置 = 用默认值继续跑，不拒绝启动",
       c.server == "ws://localhost:9100")
    os.remove(os.path.join(D, config.CONFIG_FILE))

    # ---------- identity: pairing result survives a rename ----------
    ok("C7 未配对时没有身份文件", config.load_identity(D) == {})
    config.save_identity(D, host_id="friends-desktop", node_key="a" * 32, server="ws://x:9100")
    config.save_identity(D, install_id="keepme")
    ident = config.load_identity(D)
    ok("C8 身份文件合并写入：配对信息不会被后写的字段抹掉",
       ident.get("host_id") == "friends-desktop" and ident.get("install_id") == "keepme"
       and ident.get("node_key") == "a" * 32, json.dumps(list(sorted(ident))))

    c = resolve()
    ok("C9 已配对的机器不再看主机名：改名不会变成新节点",
       c.host_id == "friends-desktop" and c.sources["host_id"] == config.IDENTITY_FILE,
       c.host_id)
    ok("C10 节点密钥只在 host_id 对得上时才拿出来用",
       c.node_key == "a" * 32)
    c2 = resolve({"host_id": "someone-elses-box"})
    ok("C10b 换了 host_id 就不带旧密钥（否则等于用别人的写权限上报）",
       c2.host_id == "someone-elses-box" and c2.node_key is None)

    with open(os.path.join(D, config.IDENTITY_FILE), "w", encoding="utf-8") as f:
        f.write("not json either")
    c3 = resolve()
    ok("C11 身份文件写坏也不炸：当作没配过，继续用默认",
       c3.host_id != "friends-desktop" and c3.node_key is None, c3.host_id)
    config.save_identity(D, host_id="friends-desktop", node_key="a" * 32)

    # ---------- fingerprint ----------
    fp1, src1 = config.machine_fingerprint(D)
    fp2, src2 = config.machine_fingerprint(D)
    ok("C12 机器指纹稳定且为 16 位 hex（原始 machine-id 不出机器）",
       fp1 == fp2 and src1 == src2 and len(fp1) == 16
       and all(ch in "0123456789abcdef" for ch in fp1), f"{src1}/{fp1[:8]}…")

    # The fallback branch is environment-dependent (this box has a real machine
    # id), so C13 proves the contract that holds either way: a 16-hex digest,
    # and if it came from install-id then that id is now on disk.
    empty = tempfile.mkdtemp(prefix="hm-agent-noid-")
    fp3, src3 = config.machine_fingerprint(empty)
    ok("C13 任何机器都能给出指纹；走兜底时 install_id 已落盘",
       len(fp3) == 16 and (src3 != "install-id"
                           or os.path.exists(os.path.join(empty, config.IDENTITY_FILE))),
       f"{src3}/{fp3[:8]}…")
    shutil.rmtree(empty, ignore_errors=True)

    ok("C14 原子写：不留下 .tmp 残骸",
       not [n for n in os.listdir(D) if n.endswith(".tmp")],
       str([n for n in os.listdir(D)]))
finally:
    shutil.rmtree(D, ignore_errors=True)

print(f"\n[config-selftest] pass={pass_} fail={fail}")
sys.exit(1 if fail else 0)
