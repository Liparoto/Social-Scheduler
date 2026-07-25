"""Preflight: verify channel credentials WITHOUT publishing anything.

For each configured channel (or one via --channel), checks that platform's read-only
proof of reachability:
  * Instagram — the content_publishing_limit endpoint. A success proves the access
    token and IG user id are valid and content-publishing is reachable; it also
    reports the account's real remaining quota.
  * Facebook Pages — a plain node read (id, name). Pages have no
    content_publishing_limit endpoint, so this instead proves the Page token and
    Page id are valid and the Page is reachable. There is no publish quota to report.
  * Threads — the threads_publishing_limit endpoint, same idea as Instagram's check
    but via its own quota method.
  * Any other platform — reported as unchecked (no adapter), never silently checked
    against another platform's endpoint.

Uses ClientRegistry so each channel is checked against the correct Graph host for its
platform (Facebook is always graph.facebook.com; Instagram uses the install's
META_GRAPH_BASE).

    python3 -m worker.preflight              # check every active channel
    python3 -m worker.preflight --channel 1  # check just channel #1

Never prints the access token.
"""

from __future__ import annotations

import sys

from . import db
from .clients import PLATFORM_CAPS, ClientRegistry
from .config import Config
from .graph_api import GraphAPIError
from .redact import redact


def _check_facebook(client, ch, name, print_fn) -> None:
    info = client.get_page_info(ch["remote_account_id"], ch["access_token"])
    page_name = info.get("name", ch["account_name"])
    print_fn(
        f"  ✓ {name}: token OK — Page reachable "
        f"({page_name}; Pages have no publish quota)"
    )


def _check_instagram(client, ch, name, print_fn) -> None:
    usage, total, duration = client.get_content_publishing_limit(
        ch["remote_account_id"], ch["access_token"]
    )
    hours = (duration or 0) // 3600
    print_fn(
        f"  ✓ {name}: token OK — published {usage}/{total} in the last {hours}h window"
    )


def _check_threads(client, ch, name, print_fn) -> None:
    usage, total, duration = client.get_threads_publishing_limit(
        ch["remote_account_id"], ch["access_token"]
    )
    hours = (duration or 0) // 3600
    print_fn(
        f"  ✓ {name}: token OK — published {usage}/{total} in the last {hours}h window"
    )


def _check_discord(client, ch, name, print_fn) -> None:
    """A plain GET on the webhook URL — the URL IS the credential, so this proves
    reachability without publishing anything. Never print the URL itself, only what
    Discord reports the webhook is named."""
    info = client.get_webhook(ch["access_token"])
    webhook_name = info.get("name", ch["account_name"])
    print_fn(
        f"  ✓ {name}: webhook OK — reachable ({webhook_name}; webhooks have no publish quota)"
    )


def _check_telegram(client, ch, name, print_fn) -> None:
    """getMe proves the bot token is valid; getChat proves the bot can actually see the
    target chat (a valid token alone doesn't guarantee that). Neither publishes anything
    or exposes a publish quota — Telegram's Bot API has none."""
    client.get_me(ch["access_token"])
    chat = client.get_chat(ch["access_token"], ch["remote_account_id"])
    title = chat.get("title") or chat.get("username") or ch["account_name"]
    print_fn(
        f"  ✓ {name}: token OK — chat reachable ({title}; no publish quota)"
    )


# One check per platform. A bare `else` here is how a Facebook Page got preflighted
# against Instagram's quota endpoint; an unknown platform must be reported, not guessed.
_CHECKS = {
    "instagram": _check_instagram,
    "facebook": _check_facebook,
    "threads": _check_threads,
    "discord": _check_discord,
    "telegram": _check_telegram,
}


def check_channels(rows, registry: ClientRegistry, *, print_fn=print) -> bool:
    """Check every channel row. Returns True iff all of them are reachable.

    Split out from main() so tests can drive it against a fake ClientRegistry/client
    without touching real env/DB wiring.
    """
    all_ok = True
    for ch in rows:
        name = f"#{ch['id']} {ch['account_name']} ({ch['platform']})"
        if not ch["access_token"]:
            print_fn(f"  ✗ {name}: no access token set")
            all_ok = False
            continue
        caps = PLATFORM_CAPS.get(ch["platform"])
        # Discord's webhook URL is both address and secret, so it has no separate
        # account id to require — only platforms that actually use one (caps.uses_account_id,
        # or an unrecognised platform where we can't yet tell) are checked for it.
        needs_account_id = caps is None or caps.uses_account_id
        if needs_account_id and not ch["remote_account_id"]:
            print_fn(f"  ✗ {name}: no account id set")
            all_ok = False
            continue
        check = _CHECKS.get(ch["platform"])
        if check is None:
            print_fn(
                f"  ✗ {name}: no preflight check for platform '{ch['platform']}' "
                f"— this worker has no adapter for it"
            )
            all_ok = False
            continue
        try:
            check(registry.for_platform(ch["platform"]), ch, name, print_fn)
        except GraphAPIError as exc:
            print_fn(f"  ✗ {name}: {redact(str(exc))}")
            all_ok = False
        except Exception as exc:  # noqa: BLE001
            print_fn(f"  ✗ {name}: {redact(str(exc))}")
            all_ok = False
    return all_ok


def main() -> int:
    config = Config.from_env()
    conn = db.connect(config.database_path)
    registry = ClientRegistry(config)

    channel_id = None
    if "--channel" in sys.argv:
        try:
            channel_id = int(sys.argv[sys.argv.index("--channel") + 1])
        except (IndexError, ValueError):
            print("Usage: python3 -m worker.preflight [--channel <id>]", file=sys.stderr)
            return 2

    if channel_id is not None:
        rows = conn.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM channels WHERE is_active = 1").fetchall()

    if not rows:
        print("No channels to check. Add one in the dashboard first.")
        return 0

    print(f"Graph API {config.graph_version} — checking {len(rows)} channel(s)\n")
    all_ok = check_channels(rows, registry)

    print()
    print("All channels reachable." if all_ok else "Some channels failed — see above.")
    conn.close()
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
