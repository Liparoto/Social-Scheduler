"""One worker per install, enforced by a lock the operating system owns.

Row claiming (db.claim_publication) already stops two daemons publishing the SAME row.
This closes the wider problem: two daemons should not both exist. They double every API
call against a shared rate limit, race the auto-fill queue-depth logic, and make the logs
describe two interleaved realities.

**A lock, not a pid file.** `data/run/worker.pid` was never a guard, only a note left by
the launcher, and a pid file cannot be one: it outlives the process that wrote it. After a
crash, a `kill -9`, or a power cut it names a process that no longer exists — and once the
OS recycles that number onto something unrelated, a liveness check on it returns *alive*
and the guard blocks a worker that should have started. `flock` has neither failure mode:
the kernel releases it when the holding process dies, however it dies.

**Per install, by construction.** The lock file lives in this install's own `data/run`, so
a second clone of the repo — a separate database and a separate queue — is unaffected.
Two installs are supposed to run at once; two workers on one install are not.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

# The lock primitive differs by platform, and so does the IMPORT: `fcntl` does not exist on
# Windows and `msvcrt` does not exist anywhere else. That is why this is a module-level
# branch rather than a check inside acquire() — an unconditional `import fcntl` is what
# stopped the worker starting at all on Windows, since run.py imports this module before it
# runs a line. The dashboard came up fine and the worker died into its log file, so the
# install looked healthy and simply never published (broken 2026-08-05 by the commit that
# added this guard; Windows launchers have shipped since 2026-07-23).
#
# Both primitives keep the property the docstring above rests on: the kernel drops the lock
# when the holding process dies, however it dies. Neither is a pid file.
if os.name == "nt":
    import msvcrt

    # Lock a byte far past the end of the file rather than byte 0. Windows file locks are
    # MANDATORY, not advisory like flock — locking byte 0 would make the holder's own pid
    # write below fail. Locking beyond EOF is legal, costs nothing, and never overlaps the
    # bytes we read and write.
    _LOCK_BYTE = 0x7FFF_0000

    def _lock_exclusive_nowait(handle) -> None:
        handle.seek(_LOCK_BYTE)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(handle) -> None:
        handle.seek(_LOCK_BYTE)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

else:
    import fcntl

    def _lock_exclusive_nowait(handle) -> None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(handle) -> None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


# The pid is written as a FIXED-WIDTH field so recording it never needs truncate(). That
# matters on Windows, where the file carries a mandatory lock region and a truncate is one
# more thing that can fail on a platform this project cannot test from a Mac; a fixed field
# means a shorter pid can never leave digits of a longer predecessor behind. Readers strip.
_PID_FIELD = 20


class AlreadyRunning(Exception):
    """Another worker already holds this install's lock.

    Carries the holder's pid when it could be read — for a human to act on, never for
    the guard to trust. The lock itself is the authority.
    """

    def __init__(self, holder_pid: str | None = None) -> None:
        self.holder_pid = holder_pid
        super().__init__(
            f"another worker is already running (pid {holder_pid or 'unknown'})"
        )


# Held open for the life of the process: closing the file releases the lock, so this
# reference is what keeps the guard in force. A local variable would be garbage-collected
# and the lock would quietly disappear while the worker kept running.
_handle = None


def acquire(lock_path: Path, wait_seconds: float = 6.0) -> None:
    """Take this install's worker lock, or raise AlreadyRunning.

    `wait_seconds` exists for restarts, not for queueing. `launchctl kickstart -k` starts
    the replacement while the outgoing worker is still unwinding its final cycle, so a
    strictly non-blocking acquire would lose a race it was always going to win a moment
    later — and, because the agent restarts on non-zero exit, would turn that into a
    restart loop. Retrying briefly absorbs the handover; anything longer than a few
    seconds means a worker really is running, and waiting for it is not this process's
    job.
    """
    global _handle

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # O_RDWR|O_CREAT: created if absent, never truncated on open — truncating would destroy
    # the holder's pid before we know whether we can even take the lock. Deliberately NOT
    # append mode: "a+" forces every write to EOF regardless of seek, so overwriting the pid
    # in place would instead grow the file on each acquire.
    handle = os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644), "r+")

    deadline = time.monotonic() + max(wait_seconds, 0.0)
    while True:
        try:
            _lock_exclusive_nowait(handle)
            break
        except OSError:
            if time.monotonic() >= deadline:
                handle.seek(0)
                holder = handle.read().strip() or None
                handle.close()
                raise AlreadyRunning(holder) from None
            time.sleep(0.25)

    # Record who holds it. Diagnostic only — a human reading the file, or the error
    # message above. Nothing decides anything from this value.
    handle.seek(0)
    handle.write(f"{os.getpid():<{_PID_FIELD}}")
    handle.flush()
    _handle = handle


def release() -> None:
    """Drop the lock. The OS does this on exit anyway; this is for tests and for a clean
    shutdown that wants to be explicit about it."""
    global _handle
    if _handle is not None:
        try:
            _unlock(_handle)
        finally:
            _handle.close()
            _handle = None
