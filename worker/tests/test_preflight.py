"""Tests for preflight: platform-branched channel checks that never touch a real Graph API.

Facebook Pages have no content_publishing_limit endpoint, so preflight must never call it
for a Facebook channel — calling it there is exactly the bug this file guards against
(Meta returns "(#100) Tried accessing nonexisting field ... on node type Page", which used
to make preflight report a healthy Page as FAILED).
"""

from __future__ import annotations

from worker.clients import ClientRegistry
from worker.preflight import check_channels


def _registry(config, fake_client):
    # A registry whose factory always hands back the same fake client, regardless of
    # platform — check_channels only cares that for_platform() is called with the right
    # platform and that the correct method is invoked on whatever it returns.
    return ClientRegistry(config, factory=lambda version, base: fake_client)


def test_facebook_channel_passes_without_content_publishing_limit_call(
    config, fake_client, make_publication
):
    pub = make_publication(platform="facebook")
    channel = {
        "id": pub["channel_id"],
        "account_name": "Test FB Page",
        "platform": "facebook",
        "access_token": "tok-123",
        "remote_account_id": "PAGE1",
    }
    lines = []
    ok = check_channels([channel], _registry(config, fake_client), print_fn=lines.append)

    assert ok is True
    kinds = [k for k, _ in fake_client.calls]
    assert kinds == ["page_info"]
    assert "limit" not in kinds
    assert any("Page reachable" in line for line in lines)
    # Never print the token.
    assert not any("tok-123" in line for line in lines)


def test_instagram_channel_still_makes_exactly_the_quota_call(config, fake_client):
    channel = {
        "id": 1,
        "account_name": "Test IG",
        "platform": "instagram",
        "access_token": "tok-abc",
        "remote_account_id": "178414",
    }
    lines = []
    ok = check_channels([channel], _registry(config, fake_client), print_fn=lines.append)

    assert ok is True
    kinds = [k for k, _ in fake_client.calls]
    assert kinds == ["limit"]
    assert any("published" in line for line in lines)
    assert not any("tok-abc" in line for line in lines)


def test_facebook_channel_failure_is_visible_and_never_leaks_token(config, fake_client):
    fake_client.fail_on.add("page_info")
    channel = {
        "id": 2,
        "account_name": "Broken Page",
        "platform": "facebook",
        "access_token": "super-secret-token",
        "remote_account_id": "PAGE2",
    }
    lines = []
    ok = check_channels([channel], _registry(config, fake_client), print_fn=lines.append)

    assert ok is False
    assert any("✗" in line for line in lines)
    assert not any("super-secret-token" in line for line in lines)


def test_missing_token_or_account_id_fails_without_any_api_call(config, fake_client):
    channels = [
        {"id": 3, "account_name": "No Token", "platform": "facebook",
         "access_token": None, "remote_account_id": "PAGE3"},
        {"id": 4, "account_name": "No Account Id", "platform": "instagram",
         "access_token": "tok", "remote_account_id": None},
    ]
    lines = []
    ok = check_channels(channels, _registry(config, fake_client), print_fn=lines.append)

    assert ok is False
    assert fake_client.calls == []
