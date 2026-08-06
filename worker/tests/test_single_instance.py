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
