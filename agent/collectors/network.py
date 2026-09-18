"""Network speed collector - calculates throughput via psutil counter deltas."""
import psutil
import time

# State for delta calculation
_last_counters = None
_last_time = None


def collect():
    """Collect network throughput (upload/download) in Mbps.

    Uses two-sample delta approach: current counters minus last counters / elapsed time.
    First call returns zeros (no previous sample).
    """
    global _last_counters, _last_time

    current_counters = psutil.net_io_counters()
    current_time = time.time()

    if _last_counters is None or _last_time is None:
        _last_counters = current_counters
        _last_time = current_time
        return {
            "upload_mbps": 0.0,
            "download_mbps": 0.0,
            "total_sent_gb": round(current_counters.bytes_sent / (1024**3), 2),
            "total_recv_gb": round(current_counters.bytes_recv / (1024**3), 2),
        }

    elapsed = current_time - _last_time
    if elapsed <= 0:
        elapsed = 1.0

    upload_bytes = current_counters.bytes_sent - _last_counters.bytes_sent
    download_bytes = current_counters.bytes_recv - _last_counters.bytes_recv

    # Convert bytes/sec to Mbps (megabits per second)
    upload_mbps = round((upload_bytes * 8) / (elapsed * 1_000_000), 2)
    download_mbps = round((download_bytes * 8) / (elapsed * 1_000_000), 2)

    _last_counters = current_counters
    _last_time = current_time

    return {
        "upload_mbps": upload_mbps,
        "download_mbps": download_mbps,
        "total_sent_gb": round(current_counters.bytes_sent / (1024**3), 2),
        "total_recv_gb": round(current_counters.bytes_recv / (1024**3), 2),
    }
