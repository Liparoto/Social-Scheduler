"""0026 gives TikTok's lifetime like total a column of its own."""

from __future__ import annotations


def test_lifetime_likes_exists_and_defaults_to_null(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(account_metrics)")}
    assert "lifetime_likes" in cols

    conn.execute(
        "INSERT INTO channels (platform, account_name, timezone) VALUES ('tiktok','tt','UTC')"
    )
    ch = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO account_metrics (channel_id, day, fetched_at) VALUES (?, '2026-08-23', ?)",
        (ch, "2026-08-23T00:00:00Z"),
    )
    conn.commit()
    row = conn.execute(
        "SELECT likes, lifetime_likes FROM account_metrics WHERE channel_id = ?", (ch,)
    ).fetchone()
    # Distinct columns: a daily value and a lifetime total must never share one.
    assert row[0] is None and row[1] is None


def test_the_daily_likes_column_still_exists(conn):
    """The point of the new column is that it does NOT replace the daily one."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(account_metrics)")}
    assert "likes" in cols and "lifetime_likes" in cols
