"""Exercise the real session, CSRF and TV-key proxy using an in-memory TV service."""

import httpx
import pytest
from fastapi.testclient import TestClient

import main

PASSWORD = "correct-operator-password-at-least-32-chars"
KEY = "tv-admin-key-at-least-32-characters-long"
SECRET = "different-session-secret-at-least-32-chars"
BASE = "https://dashboard.example"


@pytest.fixture
def dashboard(monkeypatch):
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