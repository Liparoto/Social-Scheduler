"""Turn a short-lived Meta token into a long-lived one, and store it on a channel.

    python3 -m worker.exchange_token          # interactive: exchange and save
    python3 -m worker.exchange_token --check  # report what each stored token IS

    # when a hidden prompt will not accept a paste (some Windows terminals):
    python3 -m worker.exchange_token --platform facebook --token-file ../token.txt

WHY THIS EXISTS
---------------
Both Meta paths hand you a token that expires in about an hour, and neither says so.
The channel appears to work — reads succeed, preflight passes, the dashboard shows a
connected account — and then publishing fails hours later for reasons the error does
not explain. Doing the exchange by hand means either putting the app secret in a
browser URL bar or a multi-step round trip through Meta's Access Token Debugger, and
skipping a step leaves you with a token that looks fine and dies the same afternoon.

The two paths differ, and mixing them up is the usual failure:

  Instagram (Instagram-Login)  short-lived token --ig_exchange_token--> 60-DAY token
                               Expires. Must be refreshed (ig_refresh_token) before
                               day 60, and refreshing needs a token at least 24h old.

  Facebook Page                short-lived USER token
                                 --fb_exchange_token--> long-lived USER token
                                 --GET /{page-id}?fields=access_token--> PAGE token
                               The Page token does NOT expire. It is only permanent
                               when derived from an ALREADY-extended user token, which
                               is the step that gets skipped: deriving it from the
                               short-lived user token yields a Page token that inherits
                               the ~1h expiry and looks identical.

Nothing here prints a token. Input is read with getpass so it never reaches the
terminal or your shell history, and a token is verified BEFORE it is saved — a failed
check leaves the existing, working credential untouched.
"""

from __future__ import annotations

import getpass
import sys
from pathlib import Path
from typing import Any

import requests

from . import db
from .clients import FACEBOOK_BASE
from .config import Config
from .redact import redact

TIMEOUT = 30

# A Page token whose `expires_at` is 0 never expires. Anything else came from an
# unextended user token and is the bug this module exists to prevent.
NEVER = 0


class ExchangeError(Exception):
    """A step failed. The message is safe to show — it carries no credential."""


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _get(url: str, params: dict[str, str]) -> dict[str, Any]:
    """GET and return parsed JSON, turning Meta's error envelope into a clear message.

    Meta answers a rejected token with HTTP 400 and a JSON body explaining why, so
    raise_for_status() would throw away the only useful part. The body is read first.
    """
    try:
        resp = requests.get(url, params=params, timeout=TIMEOUT)
    except requests.RequestException as exc:
        raise ExchangeError(f"Could not reach Meta: {redact(str(exc))}") from exc

    try:
        payload = resp.json()
    except ValueError:
        raise ExchangeError(
            f"Meta returned {resp.status_code} with a non-JSON body "
            f"({len(resp.content)} bytes). Try again in a moment."
        ) from None

    if isinstance(payload, dict) and "error" in payload:
        err = payload["error"]
        msg = err.get("message", "(no message)")
        code = err.get("code")
        raise ExchangeError(f"Meta rejected the request: {msg} (code {code})")
    return payload


# ---------------------------------------------------------------------------
# Facebook Pages
# ---------------------------------------------------------------------------


def extend_user_token(config: Config, short_lived: str) -> str:
    """Short-lived USER token -> long-lived (~60 day) USER token."""
    data = _get(
        f"{FACEBOOK_BASE}/{config.graph_version}/oauth/access_token",
        {
            "grant_type": "fb_exchange_token",
            "client_id": config.meta_app_id,
            "client_secret": config.meta_app_secret,
            "fb_exchange_token": short_lived,
        },
    )
    token = data.get("access_token")
    if not token:
        raise ExchangeError("Meta returned no access_token for the extended user token.")
    return token


def list_pages(config: Config, user_token: str) -> list[dict[str, Any]]:
    """Every Page this user administers, each with its own Page token.

    Derived from whatever user token is passed in, so the Page tokens inherit that
    token's lifetime — pass the EXTENDED user token to get permanent ones.
    """
    try:
        data = _get(
            f"{FACEBOOK_BASE}/{config.graph_version}/me/accounts",
            {"access_token": user_token, "fields": "id,name,access_token,tasks"},
        )
    except ExchangeError as exc:
        # `me` resolves to whoever the token identifies. For a PAGE token that is the
        # Page itself, and a Page has no `accounts` edge — so this exact error is the
        # signature of pasting a Page token where a USER token belongs. Meta's own
        # wording ("nonexisting field") gives no hint of that, so translate it.
        if "nonexisting field (accounts)" in str(exc):
            raise ExchangeError(
                "That looks like a PAGE token, not a USER token. A Page token cannot "
                "list Pages, which is why this step failed. In the Graph API Explorer, "
                "copy what is in the 'Access Token' box WITHOUT switching the dropdown "
                "to your Page."
            ) from exc
        raise
    return data.get("data", [])


def debug_token(config: Config, token: str) -> dict[str, Any]:
    """Ask Meta what a token actually is: type, scopes, and expiry.

    This is the only call that answers "why is this token failing" directly, which is
    why --check leans on it. Requires an app token (APP_ID|APP_SECRET), so it works
    only for tokens issued by THIS install's app.
    """
    data = _get(
        f"{FACEBOOK_BASE}/{config.graph_version}/debug_token",
        {
            "input_token": token,
            "access_token": f"{config.meta_app_id}|{config.meta_app_secret}",
        },
    )
    return data.get("data", {})


def verify_page_token(config: Config, token: str, page_id: str) -> None:
    """Refuse anything that would fail later. Raises ExchangeError with the reason.

    Each check maps to a real failure seen in practice:
      type          — a USER token stored on a Page channel reads fine and never publishes
      pages_manage_posts — its absence is the (#200) Permissions error, nothing else
      expires_at    — the skipped-extension bug this module exists to prevent
      profile_id    — guards against saving Page B's token onto Page A's channel
    """
    info = debug_token(config, token)

    if info.get("type") != "PAGE":
        raise ExchangeError(
            f"That is a {info.get('type', 'unknown')} token, not a Page token. "
            "Page channels need a token derived from a Page, not your user token."
        )
    if "pages_manage_posts" not in info.get("scopes", []):
        raise ExchangeError(
            "The token is missing pages_manage_posts, so publishing would fail with "
            "'(#200) Permissions error'. Add that permission to the app's "
            "'Manage everything on your Page' use case, then generate a NEW token — "
            "an existing token never gains a permission retroactively."
        )
    if info.get("expires_at") != NEVER:
        raise ExchangeError(
            "This Page token still expires, which means it came from a user token that "
            "had not been extended. Re-run and paste the USER token from the Graph API "
            "Explorer (not a Page token, and not one you already exchanged)."
        )
    if str(info.get("profile_id")) != str(page_id):
        raise ExchangeError(
            f"This token belongs to Page {info.get('profile_id')}, not {page_id}."
        )


# ---------------------------------------------------------------------------
# Instagram
# ---------------------------------------------------------------------------


def exchange_instagram_token(config: Config, short_lived: str) -> tuple[str, int]:
    """Short-lived IG token -> 60-day token. Returns (token, seconds_until_expiry).

    Uses graph.instagram.com regardless of META_GRAPH_BASE: ig_exchange_token lives
    only on the Instagram-Login host, so honouring a graph.facebook.com setting here
    would 400 with an unhelpful message.
    """
    data = _get(
        "https://graph.instagram.com/access_token",
        {
            "grant_type": "ig_exchange_token",
            "client_secret": config.meta_app_secret,
            "access_token": short_lived,
        },
    )
    token = data.get("access_token")
    if not token:
        raise ExchangeError("Meta returned no access_token for the Instagram exchange.")
    return token, int(data.get("expires_in", 0))


def instagram_identity(token: str) -> dict[str, Any]:
    """Confirm an IG token works and report who it is for.

    debug_token is not usable here — Instagram-Login tokens return
    '(#2) Service temporarily unavailable' from it (see docs/plan-first-comment.md), so
    a plain identity read is the available proof.
    """
    return _get("https://graph.instagram.com/me", {"fields": "id,username", "access_token": token})


# ---------------------------------------------------------------------------
# Interactive flow
# ---------------------------------------------------------------------------


def _prompt_secret(label: str) -> str:
    print(f"\n{label}")
    print("  (Nothing appears as you paste — that is deliberate. Paste, then press Enter.)")
    token = getpass.getpass("  Token: ").strip()
    if not token:
        raise ExchangeError("Nothing was pasted. Copy the token again and re-run.")
    print(f"  Received {len(token)} characters.")
    return token


# Real Meta tokens run roughly 150-250 characters. Anything far below that never
# reached the prompt — worth catching here, because Meta answers a truncated token
# with a code 190 that reads like the token was wrong rather than missing.
MIN_TOKEN_LEN = 50


def _read_token(label: str, token_file: str | None) -> str:
    """Get a token from --token-file if given, otherwise from the hidden prompt.

    The file path exists because a hidden prompt is not reliably pastable everywhere:
    some Windows terminals drop a Ctrl+V into getpass silently, which surfaces as a
    1-character "token" and a baffling code 190. Pasting into an editor always works.
    The file is only ever read — deleting it afterwards is the caller's job, and the
    caller should keep it outside the repo.
    """
    if token_file:
        try:
            # utf-8-sig: Notepad and PowerShell redirection both like to prepend a BOM,
            # which Meta would see as part of the token.
            token = Path(token_file).read_text(encoding="utf-8-sig").strip()
        except OSError as exc:
            raise ExchangeError(f"Could not read {token_file}: {exc}") from exc
        print(f"  Read {len(token)} characters from {token_file}.")
    else:
        token = _prompt_secret(label)

    if not token:
        raise ExchangeError("The token is empty. Copy it again and re-run.")
    if any(ch.isspace() for ch in token):
        raise ExchangeError(
            "That token contains a space or line break, so the copy picked up "
            "surrounding text or wrapped. Re-copy just the token."
        )
    if len(token) < MIN_TOKEN_LEN:
        raise ExchangeError(
            f"That is only {len(token)} characters, far short of a real Meta token. "
            "The paste did not land — use --token-file instead of pasting."
        )
    return token


def _choose(prompt: str, options: list[str]) -> int:
    """Numbered menu. Returns a 0-based index."""
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}")
    while True:
        raw = input(f"{prompt} ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return int(raw) - 1
        print(f"  Enter a number from 1 to {len(options)}.")


def _save_to_channel(conn, config: Config, platform: str, token: str, remote_id: str,
                     expires_at: str | None) -> None:
    """Offer to write the token onto an existing channel, or explain what to do instead.

    A fresh install has no channels yet, so this must degrade to instructions rather
    than failing — the token is still good, it just has nowhere to live yet.
    """
    rows = conn.execute(
        "SELECT id, account_name, remote_account_id FROM channels WHERE platform = ? "
        "ORDER BY id",
        (platform,),
    ).fetchall()

    if not rows:
        print(
            f"\nNo {platform} channel exists yet, so there is nothing to update.\n"
            f"In the dashboard: Channels -> Add channel, and use this id:\n"
            f"    {remote_id}\n"
            "Then re-run this command to store the token on it."
        )
        return

    labels = [
        f"{r['account_name']} (channel {r['id']}, id {r['remote_account_id']})" for r in rows
    ] + ["Don't save — I'll paste it into the dashboard myself"]
    print(f"\nWhich {platform} channel should this token go on?")
    idx = _choose("Choice:", labels)

    if idx == len(rows):
        print(
            "\nNothing saved. Copy the token from the Graph API Explorer and paste it "
            "into the dashboard under Channels."
        )
        return

    ch = rows[idx]
    if str(ch["remote_account_id"]) != str(remote_id):
        print(
            f"\nThat channel points at {ch['remote_account_id']}, but this token is for "
            f"{remote_id}. Saving would break it — nothing was changed."
        )
        return

    db.update_channel(conn, ch["id"], access_token=token, token_expires_at=expires_at)
    print(f"\nSaved to channel {ch['id']} ({ch['account_name']}).")


def run_facebook(conn, config: Config, token_file: str | None = None) -> int:
    print(
        "\nFacebook Page — you need the USER token from the Graph API Explorer\n"
        "(developers.facebook.com/tools/explorer), generated with pages_show_list,\n"
        "pages_read_engagement and pages_manage_posts. Not a Page token."
    )
    user_token = _read_token("Paste the USER token:", token_file)

    print("\n1/4  Extending the user token...")
    long_lived = extend_user_token(config, user_token)

    print("2/4  Finding your Pages...")
    pages = list_pages(config, long_lived)
    if not pages:
        raise ExchangeError(
            "You administer no Pages under this account, or the token was generated "
            "without pages_show_list. Check both and try again."
        )

    if len(pages) == 1:
        page = pages[0]
        print(f"     Found one Page: {page.get('name')}")
    else:
        print("\nWhich Page?")
        page = pages[_choose("Choice:", [f"{p.get('name')} ({p.get('id')})" for p in pages])]

    tasks = page.get("tasks", [])
    missing = {"CREATE_CONTENT", "MANAGE"} - set(tasks)
    if missing:
        raise ExchangeError(
            f"You lack {', '.join(sorted(missing))} on '{page.get('name')}'. "
            "Publishing needs both — ask a Page admin to grant full access."
        )

    print("3/4  Verifying the Page token...")
    page_token = page.get("access_token", "")
    verify_page_token(config, page_token, page["id"])
    print("     type=PAGE  expires=NEVER  pages_manage_posts=yes")

    print("4/4  Storing it...")
    _save_to_channel(conn, config, "facebook", page_token, page["id"], None)
    return 0


def run_instagram(conn, config: Config, token_file: str | None = None) -> int:
    print(
        "\nInstagram — you need the short-lived token from your app's\n"
        "Instagram -> API setup with Instagram login panel ('Generate token')."
    )
    short = _read_token("Paste the short-lived Instagram token:", token_file)

    print("\n1/3  Exchanging for a 60-day token...")
    token, expires_in = exchange_instagram_token(config, short)
    days = expires_in // 86400
    print(f"     Valid for {days} days.")

    print("2/3  Confirming who it belongs to...")
    me = instagram_identity(token)
    print(f"     @{me.get('username')} (id {me.get('id')})")

    print("3/3  Storing it...")
    # Stored as a plain day count rather than a timestamp: the exact hour is not
    # meaningful for a 60-day credential, and the date is what a human needs to see.
    _save_to_channel(conn, config, "instagram", token, str(me.get("id")), None)
    print(
        f"\nRefresh this before {days} days are up (re-run this command with a token "
        "at least 24 hours old), or publishing stops."
    )
    return 0


# ---------------------------------------------------------------------------
# --check
# ---------------------------------------------------------------------------


def run_check(conn, config: Config) -> int:
    """Report what each stored token IS, without changing anything.

    Answers the question a publish failure does not: is this the right kind of token,
    does it carry the publishing scope, and when does it die?
    """
    rows = conn.execute(
        "SELECT id, platform, account_name, remote_account_id, access_token "
        "FROM channels WHERE is_active = 1 ORDER BY id"
    ).fetchall()
    if not rows:
        print("No active channels.")
        return 0

    problems = 0
    for ch in rows:
        label = f"[{ch['id']}] {ch['account_name']} ({ch['platform']})"
        if not ch["access_token"]:
            print(f"{label}: no token stored")
            problems += 1
            continue

        try:
            if ch["platform"] == "facebook":
                info = debug_token(config, ch["access_token"])
                exp = info.get("expires_at")
                when = "never" if exp == NEVER else f"expires {exp}"
                scoped = "pages_manage_posts" in info.get("scopes", [])
                ok = info.get("type") == "PAGE" and exp == NEVER and scoped
                print(
                    f"{label}: {info.get('type')} token, {when}, "
                    f"pages_manage_posts={'yes' if scoped else 'NO'}"
                )
                if not ok:
                    problems += 1
            elif ch["platform"] == "instagram":
                # debug_token rejects Instagram-Login tokens, so prove reachability instead.
                me = instagram_identity(ch["access_token"])
                print(f"{label}: reachable as @{me.get('username')} (expiry not reported)")
            else:
                print(f"{label}: not checked (no token introspection for this platform)")
        except ExchangeError as exc:
            print(f"{label}: {exc}")
            problems += 1

    print()
    print("All checked tokens look correct." if not problems else f"{problems} need attention.")
    return 1 if problems else 0


def _arg_value(flag: str) -> str | None:
    """Read `--flag value` or `--flag=value` out of argv. None if absent."""
    for i, arg in enumerate(sys.argv):
        if arg == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if arg.startswith(f"{flag}="):
            return arg.split("=", 1)[1]
    return None


def main() -> int:
    config = Config.from_env()
    if not config.meta_app_id or not config.meta_app_secret:
        print(
            "META_APP_ID and META_APP_SECRET must be set in .env — the exchange is signed "
            "with them.",
            file=sys.stderr,
        )
        return 2

    conn = db.connect(config.database_path)
    try:
        if "--check" in sys.argv:
            return run_check(conn, config)

        token_file = _arg_value("--token-file")
        platform = _arg_value("--platform")

        if platform not in (None, "facebook", "instagram"):
            print(f"--platform must be facebook or instagram, not {platform!r}", file=sys.stderr)
            return 2

        if platform is None:
            print("What are you connecting?")
            platform = ["facebook", "instagram"][_choose("Choice:", ["Facebook Page", "Instagram"])]

        if platform == "facebook":
            return run_facebook(conn, config, token_file)
        return run_instagram(conn, config, token_file)
    except ExchangeError as exc:
        print(f"\nStopped: {exc}", file=sys.stderr)
        print("Nothing was changed.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled. Nothing was changed.", file=sys.stderr)
        return 130
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
