"""Dedupe store for the Snowflake poller.

Tracks which failed query/task IDs have already triggered an incident so the
same failure doesn't spawn a new channel every polling cycle.
"""

import threading
import time


class SeenFailuresStore:
    """Thread-safe in-memory set of already-alerted failure IDs with TTL cleanup."""

    def __init__(self, ttl_seconds: int = 24 * 60 * 60):
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()
        self._ttl_seconds = ttl_seconds

    def is_new(self, failure_id: str) -> bool:
        """Return True and record the ID if it hasn't been seen before (or has expired)."""
        now = time.time()
        with self._lock:
            self._cleanup(now)
            if failure_id in self._seen:
                return False
            self._seen[failure_id] = now
            return True

    def _cleanup(self, now: float) -> None:
        expired = [k for k, ts in self._seen.items() if now - ts > self._ttl_seconds]
        for k in expired:
            del self._seen[k]


seen_failures = SeenFailuresStore()
