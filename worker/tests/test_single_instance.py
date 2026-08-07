"""One worker per install.

The properties that matter: a second worker on the same install is refused, a second
worker on a DIFFERENT install is not, and a lock left behind by a process that died
badly does not block the next start — which is the whole reason this is a kernel lock
rather than a pid file.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap

import pytest

from worker import single_instance


@pytest.fixture(autouse=True)
def _release_after_each():
    yield
    single_instance.release()


def test_the_first_worker_takes_the_lock(tmp_path):
    single_instance.acquire(tmp_path / "run" / "worker.lock", wait_seconds=0)
    assert (tmp_path / "run" / "worker.lock").read_text().strip() == str(os.getpid())


def test_the_lock_file_records_the_holder_for_a_human(tmp_path):
    """Diagnostic only — the message a person reads. Nothing decides from this value."""
    lock = tmp_path / "worker.lock"
    single_instance.acquire(lock, wait_seconds=0)
    assert lock.read_text().strip().isdigit()


def _child_holding_lock(lock_path):
    """A real second process holding the lock — flock is per-process, so a same-process
    second acquire would succeed and prove nothing."""
    code = textwrap.dedent(
        f"""
        import fcntl, sys, time
        h = open({str(lock_path)!r}, "a+")
        fcntl.flock(h.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        h.seek(0); h.truncate(); h.write(str(__import__("os").getpid())); h.flush()
        sys.stdout.write("locked\\n"); sys.stdout.flush()
        time.sleep(30)
        """
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", code], stdout=subprocess.PIPE, text=True
    )
    assert proc.stdout.readline().strip() == "locked"
    return proc


def test_a_second_worker_on_the_same_install_is_refused(tmp_path):
    lock = tmp_path / "worker.lock"
    holder = _child_holding_lock(lock)
    try:
        with pytest.raises(single_instance.AlreadyRunning) as caught:
            single_instance.acquire(lock, wait_seconds=0)
        assert caught.value.holder_pid == str(holder.pid), (
            "the error should name the process actually holding it"
        )
    finally:
        holder.kill()
        holder.wait()


def test_a_worker_on_a_different_install_is_unaffected(tmp_path):
    """Two clones of this repo are two installs with two databases and two queues. They
    are SUPPOSED to run at once; only two workers on one install are the problem."""
    other = _child_holding_lock(tmp_path / "install-b.lock")
    try:
        single_instance.acquire(tmp_path / "install-a.lock", wait_seconds=0)
    finally:
        other.kill()
        other.wait()


def test_a_lock_from_a_killed_process_does_not_block_the_next_start(tmp_path):
    """The failure a pid file cannot avoid. SIGKILL leaves no chance to clean up, so a
    pid file would survive naming a dead process — and once that number is recycled, a
    liveness check reports 'alive' and blocks a worker that should have started. The
    kernel drops a flock when the holder dies, whatever killed it."""
    lock = tmp_path / "worker.lock"
    holder = _child_holding_lock(lock)
    holder.kill()
    holder.wait()

    single_instance.acquire(lock, wait_seconds=0)  # must not raise
    assert lock.read_text().strip() == str(os.getpid())


def test_acquire_waits_briefly_so_a_restart_handover_is_not_a_failure(tmp_path):
    """`launchctl kickstart -k` starts the replacement while the outgoing worker is still
    unwinding. A strictly non-blocking acquire would lose a race it was always going to
    win, and the agent's restart-on-failure rule would turn that into a loop."""
    lock = tmp_path / "worker.lock"
    holder = _child_holding_lock(lock)

    import threading

    threading.Timer(0.6, lambda: (holder.kill(), holder.wait())).start()
    single_instance.acquire(lock, wait_seconds=5)  # must not raise
    assert lock.read_text().strip() == str(os.getpid())


def test_releasing_lets_the_next_worker_in(tmp_path):
    lock = tmp_path / "worker.lock"
    single_instance.acquire(lock, wait_seconds=0)
    single_instance.release()
    single_instance.acquire(lock, wait_seconds=0)  # must not raise


def test_the_lock_directory_is_created_when_missing(tmp_path):
    """A fresh clone has no data/run yet; the guard must not be what fails first."""
    single_instance.acquire(tmp_path / "deep" / "nested" / "worker.lock", wait_seconds=0)
    assert (tmp_path / "deep" / "nested" / "worker.lock").exists()


def test_an_existing_lock_file_is_not_truncated_before_the_lock_is_won(tmp_path):
    """Truncating on open would destroy the holder's pid before we know whether we can
    take the lock, leaving the error message with nothing useful to report."""
    lock = tmp_path / "worker.lock"
    holder = _child_holding_lock(lock)
    try:
        with pytest.raises(single_instance.AlreadyRunning):
            single_instance.acquire(lock, wait_seconds=0)
        assert lock.read_text().strip() == str(holder.pid), "holder's pid must survive"
    finally:
        holder.kill()
        holder.wait()


# ---- the guard must not be Unix-only ------------------------------------------------
#
# `import fcntl` at module scope made `python -m worker.run` unstartable on Windows: run.py
# imports this module before it runs a line, so the worker died with ModuleNotFoundError
# while the dashboard came up fine — an install that looked healthy and never published.
# Windows has been a documented, launcher-supported platform since 2026-07-23; this guard
# landed 2026-08-05 and broke it. These tests fail if anyone makes it Unix-only again.


def _import_as_windows(monkeypatch, recorder):
    """Re-import single_instance with os.name forced to 'nt' and msvcrt stubbed.

    The platform branch is evaluated at IMPORT time — that is the point, since the import
    itself is what cannot work on the wrong platform — so it can only be exercised by
    importing again under a different name.
    """
    import importlib
    import types

    fake = types.ModuleType("msvcrt")
    fake.LK_NBLCK, fake.LK_UNLCK = 1, 0
    holders: set = set()

    def locking(fd, mode, nbytes):
        recorder.append((mode, nbytes, os.lseek(fd, 0, os.SEEK_CUR)))
        key = os.fstat(fd).st_ino
        if mode == fake.LK_NBLCK:
            if key in holders:
                raise OSError(36, "Resource deadlock avoided")
            holders.add(key)
        else:
            holders.discard(key)

    fake.locking = locking
    monkeypatch.setitem(sys.modules, "msvcrt", fake)

    # Make `fcntl` genuinely unimportable for the duration. Without this the test proves
    # nothing on a Mac: fcntl imports fine here, so a module that had gone back to
    # importing it unconditionally would still load and the Windows failure would sail
    # through green. Blocking it is what makes this a real simulation of Windows.
    monkeypatch.delitem(sys.modules, "fcntl", raising=False)
    monkeypatch.setattr(sys, "meta_path", [_FcntlBlocker(), *sys.meta_path])
    monkeypatch.delitem(sys.modules, "worker.single_instance", raising=False)

    # os.name is restored IMMEDIATELY after the import rather than at teardown. The module's
    # platform branch is decided at import time, so that is all the window it needs — and
    # leaving os.name == "nt" in place would make pathlib hand back WindowsPath, which
    # pytest's own failure reporting cannot instantiate on a Mac. That turns any genuine
    # failure of these tests into an INTERNALERROR that aborts the whole session instead of
    # reporting the regression they exist to catch.
    real_name = os.name
    os.name = "nt"
    try:
        module = importlib.import_module("worker.single_instance")
    finally:
        os.name = real_name

    monkeypatch.delitem(sys.modules, "worker.single_instance", raising=False)
    return module


class _FcntlBlocker:
    """A meta-path finder that makes `import fcntl` raise, the way it does on Windows."""

    def find_module(self, fullname, path=None):  # pragma: no cover - legacy hook
        return None

    def find_spec(self, fullname, path=None, target=None):
        if fullname == "fcntl":
            raise ModuleNotFoundError("No module named 'fcntl'", name="fcntl")
        return None


def test_the_guard_imports_and_locks_without_fcntl(tmp_path, monkeypatch):
    calls: list = []
    win = _import_as_windows(monkeypatch, calls)
    lock = tmp_path / "run" / "worker.lock"

    win.acquire(lock, wait_seconds=0)

    assert lock.read_text().strip() == str(os.getpid())
    # Beyond EOF on purpose: Windows locks are mandatory, so locking byte 0 would block the
    # holder's own pid write.
    assert calls[0][2] == 0x7FFF_0000


def test_a_second_worker_is_refused_without_fcntl(tmp_path, monkeypatch):
    win = _import_as_windows(monkeypatch, [])
    lock = tmp_path / "run" / "worker.lock"
    win.acquire(lock, wait_seconds=0)

    win._handle = None  # stand in for a genuinely separate process on the same install
    with pytest.raises(win.AlreadyRunning) as caught:
        win.acquire(lock, wait_seconds=0)
    assert caught.value.holder_pid == str(os.getpid())


def test_a_shorter_pid_does_not_leave_the_previous_one_behind(tmp_path, monkeypatch):
    """The pid is a fixed-width field precisely so recording it needs no truncate(), which
    is one more thing that can fail against a mandatory lock. Without the padding, pid 123
    replacing pid 99999 would read back as '12399'."""
    win = _import_as_windows(monkeypatch, [])
    lock = tmp_path / "run" / "worker.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("999999999999")

    win.acquire(lock, wait_seconds=0)
    assert lock.read_text().strip() == str(os.getpid())
