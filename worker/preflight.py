"""Preflight: verify channel credentials WITHOUT publishing anything.

For each configured channel (or one via --channel), calls the read-only
content_publishing_limit endpoint. A success proves the access token and the IG user
id are valid and that content-publishing is reachable; it also reports the account's
real remaining quota. Publishes nothing.

    python3 -m worker.preflight              # check every active channel
    python3 -m worker.preflight --channel 1  # check just channel #1

Never prints the access token.
"""

from __future__ import annotations

import sys

from . import db
from .config import Config
from .graph_api import GraphClient, GraphAPIError


def main() -> int:
    config = Config.from_env()
    conn = db.connect(config.database_path)
    client = GraphClient(config.graph_version, base_url=config.graph_base)

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
    all_ok = True
    for ch in rows:
        name = f"#{ch['id']} {ch['account_name']} ({ch['platform']})"
        if not ch["access_token"]:
            print(f"  ✗ {name}: no access token set")
            all_ok = False
            continue
        if not ch["remote_account_id"]:
            print(f"  ✗ {name}: no account id set")
            all_ok = False
            continue
        try:
            usage, total, duration = client.get_content_publishing_limit(
                ch["remote_account_id"], ch["access_token"]
            )
            hours = (duration or 0) // 3600
            print(
                f"  ✓ {name}: token OK — published {usage}/{total} in the last "
                f"{hours}h window"
            )
        except GraphAPIError as exc:
            print(f"  ✗ {name}: {exc}")
            all_ok = False
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ {name}: {exc}")
            all_ok = False

    print()
    print("All channels reachable." if all_ok else "Some channels failed — see above.")
    conn.close()
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
