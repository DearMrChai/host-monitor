"""Disk space collector - fixed partitions only, cross-platform via psutil."""
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


def collect():
    """Collect disk space usage for fixed partitions.

    Per P1 design: capacity only. IOPS belongs to L3 detail (P4), not collected yet.
    """
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
        return {"partitions": [], "worst_percent": None, "total_gb": None, "used_gb": None}

    return {
        "partitions": partitions,
        "worst_percent": max(p["percent"] for p in partitions),
        "total_gb": round(sum(p["total_gb"] for p in partitions), 2),
        "used_gb": round(sum(p["used_gb"] for p in partitions), 2),
    }
