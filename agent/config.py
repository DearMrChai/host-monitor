"""
Agent configuration + machine identity (S2b)
============================================
v1 could only answer "where do I report" by editing the scheduled task or the
systemd unit, and could not answer "who am I" at all after an OS reinstall or a
rename. This module answers both, and nothing else - collectors stay put.

Precedence (highest first):  CLI flag  >  environment  >  agent.json  >  default

Two files, deliberately separate:

  agent.json     plain config. Safe to paste into a chat when asking for help.
  identity.json  the machine's credential: the node key the Server minted when
                 this box paired. That key IS the permission to write this
                 node's data, so it never goes into agent.json, and both files
                 are gitignored.

Honest limit (do not word this as encryption anywhere): the key is stored in
plaintext next to a root shell on the node, and it travels over a plaintext LAN
WebSocket. That is the accepted boundary of this deployment form
(S2-细化设计.md §3 / 技术隐患清单.md H16); tightening it is S5's job.
"""
import hashlib
import json
import os
import platform
import socket
import subprocess
import uuid

AGENT_VERSION = "1.1.0"

CONFIG_FILE = "agent.json"
IDENTITY_FILE = "identity.json"

DEFAULTS = {
    "server": "ws://localhost:9100",
    "interval": 2.0,
    "role": "other",
    "host_id": None,
    "token": None,
}

ENV_MAP = {
    "server": "HM_SERVER",
    "interval": "HM_INTERVAL",
    "role": "HM_ROLE",
    "host_id": "HM_HOST_ID",
    "token": "HM_TOKEN",
}

ROLES = ("db", "inference", "desktop", "laptop", "display", "other")


def default_data_dir():
    """Where agent.json / identity.json live: next to the code by default."""
    return os.path.dirname(os.path.abspath(__file__))


def path_of(data_dir, name):
    return os.path.join(data_dir or default_data_dir(), name)


def read_json(path):
    """Tolerant read: a corrupt or hand-mangled config must degrade to defaults,
    not kill the agent (a monitoring agent that refuses to start is worse than
    one that starts with the wrong interval)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as e:
        print(f"[Config] Ignoring unreadable {os.path.basename(path)}: {e}")
        return {}


def write_json(path, data):
    """Atomic replace. identity.json holds a credential; a half-written file
    would leave the node unable to report until someone deletes it by hand."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)  # --data-dir may not exist yet
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def default_host_id():
    """v1 behaviour kept as the last resort: derive an id from the hostname."""
    hostname = socket.gethostname()
    host_id = hostname.lower().replace(" ", "-")
    host_id = "".join(c for c in host_id if c.isalnum() or c == "-")
    return host_id or f"host-{uuid.uuid4().hex[:8]}"


def machine_fingerprint(data_dir=None):
    """A stable per-machine value that survives renames and reinstalls of the
    agent, so the Server can notice that host_id X is now a different box (H4).

    Returns (fingerprint, source) where fingerprint is a 16-hex hash - the raw
    machine id is never put on the wire, only a digest of it.
    """
    raw, source = None, None
    try:  # Linux / WSL
        for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8", errors="ignore") as f:
                    v = f.read().strip()
                if v:
                    raw, source = v, "machine-id"
                    break
    except OSError:
        pass
    if raw is None and os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography",
                0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY,
            ) as k:
                raw = str(winreg.QueryValueEx(k, "MachineGuid")[0])
            source = "machine-guid"
        except Exception:
            raw = None
    if raw is None and platform.system() == "Darwin":
        try:
            out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                                 capture_output=True, text=True, timeout=3).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    raw = line.split('"')[-2]
                    source = "platform-uuid"
                    break
        except Exception:
            raw = None
    if raw:
        digest = hashlib.sha256(f"{source}:{raw}".encode()).hexdigest()[:16]
        return digest, source
    # Last resort: an install id we mint ourselves. It is weaker (a disk clone
    # copies it, an OS reinstall loses it), and the Server reads it as drift.
    ident = load_identity(data_dir)
    iid = ident.get("install_id")
    if not iid:
        iid = uuid.uuid4().hex
        try:
            save_identity(data_dir, install_id=iid)
        except OSError as e:
            print(f"[Config] Cannot persist install_id: {e}")
    return hashlib.sha256(f"install:{iid}".encode()).hexdigest()[:16], "install-id"


def sys_darwin():
    import platform
    return platform.system() == "Darwin"


def load_identity(data_dir=None):
    return read_json(path_of(data_dir, IDENTITY_FILE))


def save_identity(data_dir=None, **kv):
    """Merge-only: pairing must not erase the install_id, and vice versa."""
    path = path_of(data_dir, IDENTITY_FILE)
    data = read_json(path)
    changes = {k: v for k, v in kv.items() if v is not None and data.get(k) != v}
    if changes:
        data.update(changes)
        write_json(path, data)
    return data


class Config:
    """Resolved settings plus where each value came from.

    `sources` exists because "which agent.json is this reading" is the first
    question any remote debugging session asks, and there is no log channel on
    the board that answers it.
    """

    def __init__(self, values, sources, data_dir, identity):
        self.__dict__["values"] = values
        self.__dict__["sources"] = sources
        self.data_dir = data_dir
        self.identity = identity

    def __getattr__(self, name):
        try:
            return self.__dict__["values"][name]
        except KeyError:
            raise AttributeError(name)

    def describe(self):
        return "\n".join(
            f"  {k:<9}= {self.values[k]!r}   (from {self.sources[k]})"
            for k in ("server", "host_id", "role", "interval")
        )

    @property
    def node_key(self):
        """The standing key, but only for the node this file belongs to.

        Carrying a key across host_ids would either be refused (strict) or, in
        legacy mode, let one machine write another machine's data.
        """
        if self.identity.get("host_id") == self.values.get("host_id"):
            return self.identity.get("node_key")
        return None

    @property
    def key_matches_id(self):
        return self.node_key is not None


def _coerce(key, raw, warnings):
    if key == "interval":
        try:
            v = float(raw)
        except (TypeError, ValueError):
            warnings.append(f"interval={raw!r} is not a number; using default")
            return DEFAULTS[key]
        if v < 0.5 or v > 600:
            warnings.append(f"interval={v} is outside 0.5-600s; using default")
            return DEFAULTS[key]
        return v
    if key == "role":
        v = str(raw).strip().lower()
        if v not in ROLES:
            warnings.append(f"role={raw!r} is unknown; using 'other'")
            return "other"
        return v
    if key == "server":
        v = str(raw).strip()
        if not v.startswith(("ws://", "wss://")):
            warnings.append(
                f"server={raw!r} must be a ws://host:9100 URL; using default")
            return DEFAULTS[key]
        return v.rstrip("/") or DEFAULTS[key]
    if key in ("host_id", "token"):
        v = str(raw).strip()
        return v or None
    return raw


def resolve(cli=None, data_dir=None, env=None):
    """Build the effective config. `cli` is argparse-style: only keys the user
    actually typed count as overrides (argparse defaults must not beat env/file).
    `env` defaults to the real environment; tests pass an explicit dict.
    """
    cli = cli or {}
    env = os.environ if env is None else env
    data_dir = data_dir or default_data_dir()
    file_cfg = read_json(path_of(data_dir, CONFIG_FILE))
    identity = load_identity(data_dir)
    warnings = []
    values, sources = {}, {}

    for key, env_name in ENV_MAP.items():
        explicit = cli.get(key)
        from_env = env.get(env_name)
        from_file = file_cfg.get(key)
        chosen, source = DEFAULTS[key], "default"
        if explicit not in (None, ""):
            chosen, source = explicit, "cli"
        elif from_env not in (None, ""):
            chosen, source = from_env, f"env {env_name}"
        elif from_file not in (None, ""):
            chosen, source = from_file, CONFIG_FILE
        values[key] = _coerce(key, chosen, warnings) if source != "default" else chosen
        sources[key] = source

    # host_id has one extra tier between "user said so" and "guess from hostname":
    # the id this machine paired under. Renaming the box must not create a ghost.
    if sources["host_id"] == "default" and identity.get("node_key") and identity.get("host_id"):
        values["host_id"] = identity["host_id"]
        sources["host_id"] = IDENTITY_FILE
    if not values.get("host_id"):
        values["host_id"] = default_host_id()
        sources["host_id"] = "hostname"

    for w in warnings:
        print(f"[Config] Warning: {w}")
    return Config(values, sources, data_dir, identity)
