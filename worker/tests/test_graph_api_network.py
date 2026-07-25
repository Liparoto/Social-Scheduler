"""Graph API client: a network-layer failure (ConnectionError, Timeout, DNS failure)
must not leak the access_token that requests embeds in its own exception message.

Before the fix, GraphClient let requests.RequestException propagate unwrapped, and
str(exc) for a real requests.ConnectionError includes the full request URL — token and
all. That string is exactly what worker.publisher writes to publications.last_error and
the dashboard renders on the Overview page.
"""

import pytest
import requests

from worker.graph_api import GraphAPIError, GraphClient

TOKEN = "EAAB-super-secret-meta-token"


class RaisingSession:
    """A session whose post/get raise a network-layer error carrying the real token,
    exactly like a genuine requests.ConnectionError would (its message embeds the URL,
    including any query string, that the connection attempt was made to)."""

    def __init__(self, url_with_token: str):
        self._url = url_with_token

    def post(self, url, data=None, timeout=None):
        raise requests.ConnectionError(
            f"HTTPSConnectionPool(host='graph.facebook.com', port=443): "
            f"Max retries exceeded with url: /v25.0/x/media?access_token={TOKEN} "
            f"(Caused by NewConnectionError('...'))"
        )

    def get(self, url, params=None, timeout=None):
        raise requests.ConnectionError(
            f"HTTPSConnectionPool(host='graph.facebook.com', port=443): "
            f"Max retries exceeded with url: /v25.0/x?access_token={TOKEN} "
            f"(Caused by NewConnectionError('...'))"
        )


def client():
    return GraphClient("v25.0", session=RaisingSession(TOKEN))


def test_post_network_failure_raises_graph_api_error_without_leaking_token():
    c = client()
    with pytest.raises(GraphAPIError) as excinfo:
        c.create_image_container("178414", "https://assets.test/a.jpg", TOKEN)
    message = str(excinfo.value)
    assert TOKEN not in message
    # still useful: says what kind of failure this was
    assert "graph.facebook.com" in message or "ConnectionError" in message or "connection" in message.lower()


def test_get_network_failure_raises_graph_api_error_without_leaking_token():
    c = client()
    with pytest.raises(GraphAPIError) as excinfo:
        c.get_container_status("cont-1", TOKEN)
    message = str(excinfo.value)
    assert TOKEN not in message
