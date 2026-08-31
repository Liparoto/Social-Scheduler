"""Tests for the token exchange helper.

The value of this module is its refusals: every check in verify_page_token exists
because a token that passes the eye test still fails at publish time, hours later,
with an error that names none of these causes. So the tests are mostly about what it
declines to save.
"""

from __future__ import annotations

import pytest

from worker import exchange_token as ex

PAGE_ID = "269462483652949"

GOOD = {
    "type": "PAGE",
    "expires_at": 0,
    "scopes": ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    "profile_id": PAGE_ID,
}


def _patch_debug(monkeypatch, payload):
    monkeypatch.setattr(ex, "debug_token", lambda config, token: payload)


def test_a_permanent_page_token_with_the_publish_scope_is_accepted(config, monkeypatch):
    _patch_debug(monkeypatch, GOOD)
    ex.verify_page_token(config, "tok", PAGE_ID)  # does not raise


def test_a_user_token_is_rejected(config, monkeypatch):
    # A USER token stored on a Page channel reads fine — preflight passes, the channel
    # looks connected — and never publishes. Catching it here is the only cheap moment.
    _patch_debug(monkeypatch, {**GOOD, "type": "USER"})
    with pytest.raises(ex.ExchangeError, match="not a Page token"):
        ex.verify_page_token(config, "tok", PAGE_ID)


def test_a_token_without_pages_manage_posts_is_rejected(config, monkeypatch):
    # This is the (#200) Permissions error, which names neither the scope nor the fix.
    _patch_debug(monkeypatch, {**GOOD, "scopes": ["pages_show_list", "pages_read_engagement"]})
    with pytest.raises(ex.ExchangeError, match="pages_manage_posts"):
        ex.verify_page_token(config, "tok", PAGE_ID)


def test_a_page_token_that_still_expires_is_rejected(config, monkeypatch):
    # The skipped-extension bug: derived from a short-lived user token, so it inherits
    # the ~1h expiry. Publishes fine this afternoon, fails tomorrow.
    _patch_debug(monkeypatch, {**GOOD, "expires_at": 1787522400})
    with pytest.raises(ex.ExchangeError, match="still expires"):
        ex.verify_page_token(config, "tok", PAGE_ID)


def test_a_token_for_a_different_page_is_rejected(config, monkeypatch):
    # Picking the wrong Page from a multi-Page account would otherwise overwrite a
    # working channel's credential with one that cannot post to it.
    _patch_debug(monkeypatch, {**GOOD, "profile_id": "999"})
    with pytest.raises(ex.ExchangeError, match="belongs to Page 999"):
        ex.verify_page_token(config, "tok", PAGE_ID)


def test_metas_error_envelope_becomes_a_readable_message(monkeypatch):
    # requests' raise_for_status would discard the body, which is the only part that
    # says WHY the token was refused.
    class FakeResp:
        status_code = 400

        @staticmethod
        def json():
            return {"error": {"message": "Invalid OAuth access token.", "code": 190}}

    monkeypatch.setattr(ex.requests, "get", lambda *a, **k: FakeResp())
    with pytest.raises(ex.ExchangeError, match="Invalid OAuth access token"):
        ex._get("https://example.test", {})


def test_a_non_json_response_does_not_raise_a_json_decode_error(monkeypatch):
    # An HTML error page from an interception proxy used to surface as a bare
    # JSONDecodeError traceback, which tells the reader nothing about what to do.
    class FakeResp:
        status_code = 502
        content = b"<html>gateway</html>"

        @staticmethod
        def json():
            raise ValueError("no json")

    monkeypatch.setattr(ex.requests, "get", lambda *a, **k: FakeResp())
    with pytest.raises(ex.ExchangeError, match="non-JSON body"):
        ex._get("https://example.test", {})


def test_saving_refuses_when_the_channel_points_at_a_different_account(
    conn, config, capsys, monkeypatch
):
    # Guards the destructive step: overwriting a good token with one for another
    # account would break a working channel and look like a successful save.
    conn.execute(
        "INSERT INTO channels (id, platform, account_name, remote_account_id, access_token) "
        "VALUES (7, 'facebook', 'Other Page', '111', 'original')"
    )
    conn.commit()
    monkeypatch.setattr(ex, "_choose", lambda prompt, options: 0)  # pick the one channel

    ex._save_to_channel(conn, config, "facebook", "new-token", "222", None)

    assert "nothing was changed" in capsys.readouterr().out.lower()
    stored = conn.execute("SELECT access_token FROM channels WHERE id = 7").fetchone()
    assert stored["access_token"] == "original"


def test_no_channels_yet_prints_the_id_instead_of_failing(conn, config, capsys):
    # A fresh clone runs this before any channel exists. The token is still valid — it
    # just has nowhere to go — so this must instruct rather than error.
    ex._save_to_channel(conn, config, "facebook", "tok", PAGE_ID, None)
    out = capsys.readouterr().out
    assert PAGE_ID in out
    assert "Add channel" in out


FAKE_TOKEN = "EAAG" + "x" * 180  # shaped like a real Meta token, long enough to pass


def test_a_token_file_written_by_notepad_still_yields_a_clean_token(tmp_path, capsys):
    # Notepad and PowerShell redirection prepend a UTF-8 BOM, and every editor adds a
    # trailing newline. Meta would treat both as part of the token and refuse it.
    f = tmp_path / "token.txt"
    f.write_bytes(b"\xef\xbb\xbf" + FAKE_TOKEN.encode() + b"\r\n")
    assert ex._read_token("Paste:", str(f)) == FAKE_TOKEN


def test_a_swallowed_paste_is_named_instead_of_reaching_meta(monkeypatch):
    # The Windows-terminal bug this commit exists for: getpass silently drops the
    # Ctrl+V and a 1-character "token" goes to Meta, which answers with a code 190
    # that reads like the token was WRONG rather than missing.
    monkeypatch.setattr(ex, "_prompt_secret", lambda label: "v")
    with pytest.raises(ex.ExchangeError, match="--token-file"):
        ex._read_token("Paste:", None)


def test_a_token_with_a_line_break_is_rejected(tmp_path):
    # A copy that wrapped or grabbed surrounding text would fail later at Meta with
    # no hint that the paste itself was the problem.
    f = tmp_path / "token.txt"
    f.write_text(FAKE_TOKEN[:100] + "\n" + FAKE_TOKEN[100:])
    with pytest.raises(ex.ExchangeError, match="space or line break"):
        ex._read_token("Paste:", str(f))


def test_a_missing_token_file_is_an_exchange_error_not_a_traceback(tmp_path):
    with pytest.raises(ex.ExchangeError, match="Could not read"):
        ex._read_token("Paste:", str(tmp_path / "nope.txt"))


def test_a_page_token_pasted_as_a_user_token_gets_a_translated_error(config, monkeypatch):
    # `me/accounts` on a Page token fails with "nonexisting field (accounts)", which
    # says nothing about the actual mistake: the wrong dropdown in the Explorer.
    def _fake_get(url, params):
        raise ex.ExchangeError('Meta said: nonexisting field (accounts) (code 100)')

    monkeypatch.setattr(ex, "_get", _fake_get)
    with pytest.raises(ex.ExchangeError, match="PAGE token, not a USER token"):
        ex.list_pages(config, "tok")


def test_arg_value_reads_both_spellings(monkeypatch):
    # Both `--token-file x` and `--token-file=x` circulate in the docs; supporting one
    # and silently ignoring the other would fall back to the broken hidden prompt.
    monkeypatch.setattr(ex.sys, "argv", ["prog", "--token-file", "a.txt", "--platform=facebook"])
    assert ex._arg_value("--token-file") == "a.txt"
    assert ex._arg_value("--platform") == "facebook"
    assert ex._arg_value("--absent") is None
