"""Exercise the real session, CSRF and TV-key proxy using an in-memory TV service."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

import main

PASSWORD = "correct-operator-password-at-least-32-chars"
KEY = "tv-admin-key-at-least-32-characters-long"
SECRET = "different-session-secret-at-least-32-chars"
BASE = "https://dashboard.example"
ORIGINAL_ASYNC_CLIENT = httpx.AsyncClient


@pytest.fixture
def dashboard(monkeypatch):
    monkeypatch.setattr(main, "LOCAL_PASSWORDLESS", False)
    monkeypatch.setattr(main, "TV_KEY", KEY)
    monkeypatch.setattr(main, "PASSWORD", PASSWORD)
    monkeypatch.setattr(main, "SECRET", SECRET)
    monkeypatch.setattr(main, "PUBLIC_URL", BASE)
    monkeypatch.setattr(main, "TV_URL", "https://nexastream-tv.onrender.com")
    main.failures.clear()
    calls = []

    def upstream(request):
        calls.append(request)
        assert request.headers["X-Admin-Key"] == KEY
        assert request.url.host == "nexastream-tv.onrender.com"
        assert "cookie" not in request.headers
        if request.url.path == "/admin/subscribers" and request.method == "GET":
            return httpx.Response(200, json=[{"id": 1, "name": "A", "is_active": False}])
        if request.url.path == "/admin/subscribers" and request.method == "POST":
            return httpx.Response(201, json={"id": 1, "mag_portal_url": "https://nexastream-tv.onrender.com/stalker/secret/c/index.html"})
        if request.url.path == "/admin/subscribers/1" and request.method == "PATCH":
            return httpx.Response(200, json={"id": 1, "is_active": True})
        if request.url.path == "/admin/subscribers/1/rotate" and request.method == "POST":
            return httpx.Response(200, json={"mag_portal_url": "https://nexastream-tv.onrender.com/stalker/new-secret/c/index.html"})
        if request.url.path == "/admin/subscribers/2" and request.method == "PATCH":
            return httpx.Response(422, json={"detail": [{"msg": "Invalid MAC address"}]})
        return httpx.Response(404, json={"detail": "Customer not found"})

    transport = httpx.MockTransport(upstream)
    original = httpx.AsyncClient
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: original(transport=transport, **kwargs))
    with TestClient(main.app, base_url=BASE) as client:
        yield client, calls


def sign_in(client):
    result = client.post("/api/login", json={"password": PASSWORD}, headers={"Origin": BASE})
    assert result.status_code == 200, result.text
    assert "HttpOnly" in result.headers["set-cookie"] and "Secure" in result.headers["set-cookie"]
    assert "SameSite=strict" in result.headers["set-cookie"]
    return {"Origin": BASE, "X-CSRF-Token": result.json()["csrf_token"]}


def test_customer_mac_activation_and_links_are_server_proxied(dashboard):
    client, calls = dashboard
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/customers").status_code == 401
    assert client.post("/api/customers", json={}).status_code == 401
    page = client.get("/")
    assert page.status_code == 200 and "New Customer" in page.text
    script = client.get("/static/js/admin.js").text
    assert "X-Admin-Key" not in script and KEY not in script and PASSWORD not in page.text
    assert "connect-src 'self'" in page.headers["Content-Security-Policy"]

    headers = sign_in(client)
    assert client.get("/api/session").json()["csrf_token"] == headers["X-CSRF-Token"]
    assert client.get("/api/customers").json()[0]["name"] == "A"
    assert client.post("/api/customers", json={}, headers={"Origin": BASE}).status_code == 403
    assert client.post("/api/customers", json={}, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/customers", json={}, headers={"X-CSRF-Token": headers["X-CSRF-Token"]}).status_code == 403
    assert client.post("/api/customers", json=[1], headers=headers).status_code == 400
    assert client.post("/api/customers", json={"notes": "x" * 4100}, headers=headers).status_code == 413
    assert client.post("/api/customers", json={"name": "A", "mac_address": "AA:BB:CC:DD:EE:FF", "months": 1, "is_active": False}, headers=headers).status_code == 201
    assert client.patch("/api/customers/1", json={"is_active": True}, headers=headers).json()["is_active"] is True
    assert client.patch("/api/customers/1", json={"mac_address": "AA:BB:CC:DD:EE:FF"}, headers=headers).status_code == 200
    assert client.post("/api/customers/1/rotate", headers=headers).json()["mag_portal_url"].endswith("/new-secret/c/index.html")
    assert client.patch("/api/customers/2", json={"mac_address": "invalid"}, headers=headers).json()["detail"] == "Invalid MAC address"
    assert client.patch("/api/customers/0", json={"is_active": True}, headers=headers).status_code == 404
    assert [c.method for c in calls] == ["GET", "POST", "PATCH", "PATCH", "POST", "PATCH"]
    assert client.post("/api/logout", headers=headers).status_code == 200
    assert client.get("/api/customers").status_code == 401


def test_bad_logins_rate_limit_and_cookie_tampering(dashboard):
    client, _ = dashboard
    assert client.post("/api/login", json={"password": PASSWORD}, headers={"Origin": "https://evil.example"}).status_code == 403
    for _ in range(5):
        assert client.post("/api/login", json={"password": "wrong"}, headers={"Origin": BASE}).status_code == 401
    assert client.post("/api/login", json={"password": PASSWORD}, headers={"Origin": BASE}).status_code == 429
    main.failures.clear()
    sign_in(client)
    client.cookies.set(main.COOKIE, "1000000000." + "a" * 32 + "." + "b" * 64)
    assert client.get("/api/session").status_code == 401


def test_missing_secrets_fail_closed(monkeypatch):
    monkeypatch.setattr(main, "TV_KEY", "")
    monkeypatch.setattr(main, "PASSWORD", PASSWORD)
    monkeypatch.setattr(main, "SECRET", SECRET)
    monkeypatch.setattr(main, "PUBLIC_URL", BASE)
    with pytest.raises(RuntimeError, match="TV_ADMIN_API_KEY"):
        main.validate_settings()


@pytest.mark.parametrize(("upstream", "message", "status"), [
    (lambda _: httpx.Response(401), "Match dashboard TV_ADMIN_API_KEY", 502),
    (lambda _: httpx.Response(503), "PostgreSQL database status", 502),
    (lambda _: httpx.Response(302, headers={"Location": "https://other.example"}), "Check TV_API_URL", 502),
    (lambda request: (_ for _ in ()).throw(httpx.ConnectError("failed", request=request)), "Cannot reach TV service", 502),
    (lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=request)), "TV service timed out", 504),
])
def test_tv_failures_explain_what_to_check(dashboard, monkeypatch, upstream, message, status):
    client, _ = dashboard
    headers = sign_in(client)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: ORIGINAL_ASYNC_CLIENT(
        transport=httpx.MockTransport(upstream), **kwargs))
    result = client.get("/api/customers")
    assert result.status_code == status
    assert message in result.json()["detail"]
    assert KEY not in result.text
    # The TV failing must not invalidate the operator's dashboard session.
    assert client.get("/api/session").json()["csrf_token"] == headers["X-CSRF-Token"]


def test_create_rejected_key_does_not_claim_account_created(dashboard, monkeypatch):
    client, _ = dashboard
    headers = sign_in(client)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: ORIGINAL_ASYNC_CLIENT(
        transport=httpx.MockTransport(lambda _: httpx.Response(401)), **kwargs))
    result = client.post("/api/customers", json={
        "name": "Krish", "mac_address": "00:1A:79:67:CB:47", "months": 1, "is_active": True,
    }, headers=headers)
    assert result.status_code == 502
    assert "TV service rejected the admin key" in result.json()["detail"]
    assert client.get("/api/session").status_code == 200


def test_created_customer_fields_and_urls_are_forwarded(dashboard):
    client, calls = dashboard
    headers = sign_in(client)
    payload = {"name": "Krish", "mac_address": "00:1A:79:67:CB:47", "months": 1,
               "notes": None, "is_active": True}
    result = client.post("/api/customers", json=payload, headers=headers)
    assert result.status_code == 201
    assert result.json()["mag_portal_url"].endswith("/c/index.html")
    assert calls[-1].method == "POST" and calls[-1].url.path == "/admin/subscribers"
    assert json.loads(calls[-1].content) == payload


def test_passwordless_local_only_still_requires_tv_key_and_csrf(monkeypatch):
    monkeypatch.setattr(main, "LOCAL_PASSWORDLESS", True)
    monkeypatch.setattr(main, "TV_KEY", KEY)
    monkeypatch.setattr(main, "PASSWORD", "")
    monkeypatch.setattr(main, "SECRET", SECRET)
    monkeypatch.setattr(main, "PUBLIC_URL", "http://127.0.0.1:8000")
    monkeypatch.setattr(main, "TV_URL", "https://nexastream-tv.onrender.com")
    monkeypatch.delenv("RENDER_SERVICE_ID", raising=False)
    main.validate_settings()
    seen = []

    def upstream(request):
        seen.append(request)
        assert request.headers["X-Admin-Key"] == KEY
        return httpx.Response(201, json={"id": 2, "mag_portal_url": "https://nexastream-tv.onrender.com/stalker/private/c/index.html"})

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: ORIGINAL_ASYNC_CLIENT(
        transport=httpx.MockTransport(upstream), **kwargs))
    with TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000)) as client:
        first = client.get("/api/session")
        assert first.status_code == 200 and first.json()["passwordless"] is True
        assert client.post("/api/login", json={"password": ""}, headers={"Origin": "http://127.0.0.1:8000"}).status_code == 403
        assert "HttpOnly" in first.headers["set-cookie"] and "Secure" not in first.headers["set-cookie"]
        assert client.get("/api/session").json()["csrf_token"] == first.json()["csrf_token"]
        assert client.post("/api/customers", json={}).status_code == 403
        assert client.post("/api/customers", json={}, headers={"Origin": "https://evil.example", "X-CSRF-Token": first.json()["csrf_token"]}).status_code == 403
        response = client.post("/api/customers", json={"name": "Krish", "mac_address": "00:1A:79:67:CB:47", "months": 1},
                               headers={"Origin": "http://127.0.0.1:8000", "X-CSRF-Token": first.json()["csrf_token"]})
        assert response.status_code == 201 and len(seen) == 1
        assert client.get("/static/js/admin.js").status_code == 200


def test_passwordless_cannot_start_on_public_render(monkeypatch):
    monkeypatch.setattr(main, "LOCAL_PASSWORDLESS", True)
    monkeypatch.setattr(main, "PASSWORD", "")
    monkeypatch.setattr(main, "TV_KEY", KEY)
    monkeypatch.setattr(main, "SECRET", SECRET)
    monkeypatch.setattr(main, "PUBLIC_URL", BASE)
    with pytest.raises(RuntimeError, match="only on loopback"):
        main.validate_settings()
    monkeypatch.setattr(main, "PUBLIC_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv("RENDER_SERVICE_ID", "srv-example")
    with pytest.raises(RuntimeError, match="never on Render"):
        main.validate_settings()


def test_passwordless_local_does_not_authorize_nonlocal_clients(monkeypatch):
    monkeypatch.setattr(main, "LOCAL_PASSWORDLESS", True)
    monkeypatch.setattr(main, "TV_KEY", KEY)
    monkeypatch.setattr(main, "PASSWORD", "")
    monkeypatch.setattr(main, "SECRET", SECRET)
    monkeypatch.setattr(main, "PUBLIC_URL", "http://127.0.0.1:8000")
    monkeypatch.delenv("RENDER_SERVICE_ID", raising=False)
    with TestClient(main.app, base_url="http://127.0.0.1:8000", client=("203.0.113.10", 50000)) as client:
        assert client.get("/api/session").status_code == 401
        assert client.post("/api/customers", json={}).status_code == 401