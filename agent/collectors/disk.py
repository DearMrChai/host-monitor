"""Disk space + aggregate IO collector - cross-platform via psutil."""
import time

import psutil

# Defensive filter: pseudo/virtual filesystems that disk_partitions(all=False)
# may still leak through on some platforms.
_SKIP_FSTYPES = {
    "tmpfs", "devtmpfs", "squashfs", "overlay", "overlayfs",
    "proc", "sysfs", "devpts", "cgroup", "cgroup2", "pstore",
    "efivarfs", "securityfs", "debugfs", "tracefs", "mqueue",
    "hugetlbfs", "fusectl", "configfs", "binfmt_misc", "autofs",
    "bpf", "nsfs", "rpc_pipefs", "9p",
}


_last_io = None  # (read_bytes, write_bytes, ts) for the delta sample


def _collect_io():
    """Aggregate read/write throughput, MB/s. First call (no baseline) -> nulls."""
    global _last_io
    try:
        io = psutil.disk_io_counters()
    except Exception:
        return {"read_mb_s": None, "write_mb_s": None}
    if io is None:
        return {"read_mb_s": None, "write_mb_s": None}
    now = time.time()
    cur = (io.read_bytes, io.write_bytes, now)
    prev, _last_io = _last_io, cur
    if prev is None or now - prev[2] <= 0:
        return {"read_mb_s": None, "write_mb_s": None}
    dt = now - prev[2]
    return {
        "read_mb_s": round(max(cur[0] - prev[0], 0) / dt / (1024 ** 2), 2),
        "write_mb_s": round(max(cur[1] - prev[1], 0) / dt / (1024 ** 2), 2),
    }


def collect():
    """Collect disk space usage for fixed partitions + aggregate IO rate (P4).

    IO is machine-wide only: per-device name -> mountpoint mapping is not
    reliable cross-platform, so per-partition IOPS is intentionally omitted.
    """
    io = _collect_io()
    partitions = []
    for part in psutil.disk_partitions(all=False):
        if part.fstype.lower() in _SKIP_FSTYPES:
            continue
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        partitions.append({
            "mountpoint": part.mountpoint,
            "fstype": part.fstype,
            "total_gb": round(usage.total / (1024 ** 3), 2),
            "used_gb": round(usage.used / (1024 ** 3), 2),
            "percent": usage.percent,
        })

    if not partitions:
        return {"partitions": [], "worst_percent": None, "total_gb": None, "used_gb": None, "io": io}

    return {
        "partitions": partitions,
        "worst_percent": max(p["percent"] for p in partitions),
        "total_gb": round(sum(p["total_gb"] for p in partitions), 2),
        "used_gb": round(sum(p["used_gb"] for p in partitions), 2),
        "io": io,
    }
