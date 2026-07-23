"""A tiny, read-only HTTP server for the local asset store.

Meta downloads images from a public URL, so at publish time we expose the asset store
(data/assets) to a tunnel. This server does exactly one thing: serve the raw bytes of a
stored asset addressed by its <storage_path> (the content hash), and nothing else.

Security posture (see docs/design-publish-delivery.md):
  * Bound to 127.0.0.1 — only the local tunnel process can reach it.
  * Serves ONLY files that resolve inside the asset dir (path-traversal guarded).
  * No directory listing, no other routes, GET only.
  * Filenames are content hashes — unguessable.

Stdlib only (http.server + threading) so we add no dependency.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

_CONTENT_TYPE = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
}


def resolve_within(base: Path, request_path: str) -> Path | None:
    """Resolve a URL path to a file INSIDE base, or None if it escapes / isn't a file.

    Rejects absolute paths, `..` traversal, and symlinks that point outside base.
    Pulled out as a plain function so it can be unit-tested without a live server.
    """
    rel = unquote(urlparse(request_path).path).lstrip("/")
    if not rel:
        return None
    base = base.resolve()
    candidate = (base / rel).resolve()
    if candidate == base or base not in candidate.parents:
        return None
    if not candidate.is_file():
        return None
    return candidate


class _Handler(BaseHTTPRequestHandler):
    # Set by the server factory below.
    asset_dir: Path = Path(".")

    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        try:
            target = resolve_within(self.asset_dir, self.path)
        except ValueError:  # e.g. an embedded NUL byte in the path
            target = None
        if target is None:
            self.send_error(404, "Not found")
            return
        try:
            data = target.read_bytes()
        except OSError:
            self.send_error(404, "Not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", _CONTENT_TYPE.get(target.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # silence per-request stderr logging
        pass


class AssetServer:
    """Serve `asset_dir` read-only on 127.0.0.1:<port> in a background thread."""

    def __init__(self, asset_dir: Path, port: int) -> None:
        self.asset_dir = Path(asset_dir).resolve()
        handler = type("_BoundHandler", (_Handler,), {"asset_dir": self.asset_dir})
        self._httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.port = self._httpd.server_address[1]
        self._thread: threading.Thread | None = None

    def start(self) -> "AssetServer":
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread:
            self._thread.join(timeout=5)
