"""System info collector - uptime and load average."""
import os
import time

import psutil


def collect():
    """Collect system-level metrics. Windows has no load average -> None."""
    data = {"uptime_seconds": None, "load_avg": None}

    try:
        data["uptime_seconds"] = int(time.time() - psutil.boot_time())
    except Exception:
        pass

    try:
        data["load_avg"] = [round(x, 2) for x in os.getloadavg()]
    except (AttributeError, OSError):
        pass

    return data
