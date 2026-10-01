"""Private operator console for the separate NexaStream TV service."""

import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

STATIC = Path(__file__).parent / "static"
logger = logging.getLogger(__name__)
TV_URL = os.getenv("TV_API_URL", "https://nexastream-tv.onrender.com").rstrip("/")
PUBLIC_URL = os.getenv("DASHBOARD_PUBLIC_URL", os.getenv("RENDER_EXTERNAL_URL", "")).rstrip("/")
TV_KEY = os.getenv("TV_ADMIN_API_KEY", "")
PASSWORD = os.getenv("DASHBOARD_PASSWORD", "")
SECRET = os.getenv("DASHBOARD_SESSION_SECRET", "")
LOCAL_PASSWORDLESS = os.getenv("DASHBOARD_PASSWORDLESS_LOCAL", "").lower() == "true"
COOKIE = "nexastream_operator"
SESSION_SECONDS = 8 * 60 * 60
failures: dict[str, list[float]] = defaultdict(list)


def validate_settings() -> None:
    if (len(TV_KEY) < 32 or len(SECRET) < 32 or TV_KEY == SECRET
            or (not LOCAL_PASSWORDLESS and (len(PASSWORD) < 32 or PASSWORD in {TV_KEY, SECRET}))):
        raise RuntimeError("Configure distinct 32+ character TV_ADMIN_API_KEY, DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET")
    for name, value in (("TV_API_URL", TV_URL), ("DASHBOARD_PUBLIC_URL", PUBLIC_URL)):
        parsed = urlsplit(value)
        local_origin = (name == "DASHBOARD_PUBLIC_URL" and LOCAL_PASSWORDLESS
                        and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"})
        if (not local_origin and parsed.scheme != "https") or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise RuntimeError(f"{name} must be an HTTPS origin with no path or credentials (HTTP loopback allowed for local testing only)")
    if LOCAL_PASSWORDLESS and (urlsplit(PUBLIC_URL).hostname not in {"localhost", "127.0.0.1", "::1"}
                               or os.getenv("RENDER_SERVICE_ID")):
        raise RuntimeError("Passwordless testing is allowed only on loopback, never on Render")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    validate_settings()
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.update({
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    })
    return response


def session_signature(payload: str) -> str:
    return hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()


def local_request(request: Request) -> bool:
    return (LOCAL_PASSWORDLESS and request.client is not None
            and not os.getenv("RENDER_SERVICE_ID")
            and request.client.host in {"127.0.0.1", "::1"}
            and request.url.hostname in {"localhost", "127.0.0.1", "::1"})


def issue_session(passwordless: bool = False) -> JSONResponse:
    expiry = str(int(time.time()) + SESSION_SECONDS)
    csrf = secrets.token_hex(16)
    payload = f"{expiry}.{csrf}"
    response = JSONResponse({"csrf_token": csrf, "passwordless": passwordless})
    response.set_cookie(COOKIE, f"{payload}.{session_signature(payload)}", secure=not passwordless, httponly=True,
                        samesite="strict", max_age=SESSION_SECONDS, path="/")
    return response


def session(request: Request) -> str:
    raw = request.cookies.get(COOKIE, "")
    match = re.fullmatch(r"([0-9]{10})\.([a-f0-9]{32})\.([a-f0-9]{64})", raw)
    if not match:
        raise HTTPException(401, "Sign in to continue")
    expiry, csrf, signature = match.groups()
    if int(expiry) < time.time() or int(expiry) > time.time() + SESSION_SECONDS:
        raise HTTPException(401, "Session expired; sign in again")
    if not hmac.compare_digest(signature, session_signature(f"{expiry}.{csrf}")):
        raise HTTPException(401, "Sign in to continue")
    return csrf


def same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    referer = request.headers.get("referer")
    if origin != PUBLIC_URL and (origin or not referer or urlsplit(referer).scheme + "://" + urlsplit(referer).netloc != PUBLIC_URL):
        raise HTTPException(403, "Request origin is not allowed")


def authorize(request: Request) -> None:
    csrf = session(request)
    if request.method != "GET":
        same_origin(request)
        if not hmac.compare_digest(request.headers.get("x-csrf-token", ""), csrf):
            raise HTTPException(403, "Request verification failed")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/login")
async def login(request: Request) -> JSONResponse:
    if LOCAL_PASSWORDLESS:
        raise HTTPException(403, "Local testing uses the automatic loopback session")
    same_origin(request)
    data = await json_body(request)
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    failures[ip] = [moment for moment in failures[ip] if now - moment < 900]
    if len(failures[ip]) >= 5:
        raise HTTPException(429, "Too many attempts; try again in 15 minutes")
    if not hmac.compare_digest(str(data.get("password", "")), PASSWORD):
        failures[ip].append(now)
        raise HTTPException(401, "Incorrect operator password")
    failures.pop(ip, None)
    return issue_session()


@app.get("/api/session")
async def session_status(request: Request) -> JSONResponse:
    if local_request(request):
        try:
            return JSONResponse({"csrf_token": session(request), "passwordless": True})
        except HTTPException:
            return issue_session(passwordless=True)
    return JSONResponse({"csrf_token": session(request), "passwordless": False})


@app.post("/api/logout")
async def logout(request: Request) -> JSONResponse:
    authorize(request)
    response = JSONResponse({"status": "locked"})
    response.delete_cookie(COOKIE, path="/")
    return response


async def tv_request(method: str, path: str, body: dict | None = None):
    # No user-controlled host/path. The TV key never goes to browser JavaScript.
    try:
        # A sleeping free TV instance can take longer than the usual HTTPX default
        # to wake. Never automatically replay writes: a POST may have succeeded.
        async with httpx.AsyncClient(timeout=httpx.Timeout(75, connect=10), follow_redirects=False) as client:
            response = await client.request(method, f"{TV_URL}{path}", headers={"X-Admin-Key": TV_KEY}, json=body)
    except httpx.TimeoutException:
        logger.warning("TV API timed out on %s %s", method, path)
        raise HTTPException(504, "TV service timed out. Check the TV service in Render, then retry. If this was a customer change, refresh the list before trying again.") from None
    except httpx.RequestError as exc:
        logger.warning("TV API connection failed on %s %s (%s)", method, path, type(exc).__name__)
        raise HTTPException(502, "Cannot reach TV service. Check TV_API_URL and the TV service status in Render.") from None
    if response.status_code in (301, 302, 303, 307, 308):
        raise HTTPException(502, "TV service redirected the request. Check TV_API_URL (use the TV service's HTTPS origin).")
    if response.status_code == 401:
        raise HTTPException(502, "TV service rejected the admin key. Match dashboard TV_ADMIN_API_KEY to TV service ADMIN_API_KEY in Render; do not enter either key in the sign-in form.")
    if response.status_code == 503:
        try:
            database_unavailable = response.json().get("detail") == "Customer database unavailable"
        except (ValueError, AttributeError):
            database_unavailable = False
        if database_unavailable:
            logger.warning("TV customer database unavailable on %s %s", method, path)
            raise HTTPException(502, "TV customer database is unavailable. Check the TV service's Render PostgreSQL status and database logs before retrying.")
    if response.status_code >= 500:
        logger.warning("TV API returned HTTP %s on %s %s", response.status_code, method, path)
        raise HTTPException(502, "TV service returned a server error. Check its Render logs and PostgreSQL database status; then retry.")
    try:
        result = response.json()
    except ValueError:
        raise HTTPException(502, "Invalid response from TV service") from None
    if response.status_code >= 400:
        detail = result.get("detail", "TV service rejected this request") if isinstance(result, dict) else "TV service rejected this request"
        if isinstance(detail, list):
            detail = "; ".join(str(item.get("msg", "Invalid field")) for item in detail if isinstance(item, dict)) or "Invalid customer details"
        if not isinstance(detail, str):
            detail = "TV service rejected this request"
        raise HTTPException(response.status_code, detail)
    return result, response.status_code


async def json_body(request: Request) -> dict:
    try:
        if int(request.headers.get("content-length", "0")) > 4096:
            raise HTTPException(413, "Request too large")
    except ValueError:
        raise HTTPException(400, "Invalid content length") from None
    if len(await request.body()) > 4096:
        raise HTTPException(413, "Request too large")
    try:
        result = await request.json()
    except ValueError:
        raise HTTPException(400, "Invalid JSON") from None
    if not isinstance(result, dict):
        raise HTTPException(400, "A JSON object is required")
    return result


@app.get("/api/customers")
async def customers(request: Request):
    authorize(request)
    result, _ = await tv_request("GET", "/admin/subscribers")
    return JSONResponse(result)


@app.get("/api/customers/portal-settings")
async def customer_portal_settings(request: Request):
    """Operator-only shared portal configuration from the TV service."""
    authorize(request)
    try:
        result, _ = await tv_request("GET", "/admin/subscribers/portal-settings")
    except HTTPException as exc:
        if exc.status_code == 404 or (exc.status_code == 502 and exc.detail == "Invalid response from TV service"):
            raise HTTPException(502, "The TV service does not have the shared MAC portal endpoint. Deploy the updated TV service with ENABLE_MAC_STALKER_PORTAL=true, then verify /c/index.html and /portal.php before using Strimix.") from None
        raise
    return JSONResponse(result)


@app.post("/api/customers/portal-check")
async def check_customer_portal(request: Request):
    """Check an existing private URL against its account without changing the account."""
    authorize(request)
    data = await json_body(request)
    url = data.get("portal_url")
    mac = data.get("mac_address")
    if not isinstance(url, str) or not isinstance(mac, str) or not re.fullmatch(r"[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}", mac):
        raise HTTPException(422, "A private MAG URL and six-pair MAC are required")
    try:
        parsed = urlsplit(url)
    except ValueError:
        raise HTTPException(422, "Use a valid private MAG URL") from None
    match = re.fullmatch(r"/stalker/([A-Za-z0-9_-]{32,128})/c/index\.html", parsed.path)
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
            or parsed.query or parsed.fragment or not match or url != f"{parsed.scheme}://{parsed.netloc}{parsed.path}"):
        raise HTTPException(422, "Use the original private MAG URL without query or credentials")
    result, _ = await tv_request("POST", "/admin/subscribers/portal-check",
                                 {"token": match.group(1), "mac_address": mac.upper()})
    origin = result.get("portal_origin") if isinstance(result, dict) else None
    if (not isinstance(origin, str) or url != f"{origin}/stalker/{match.group(1)}/c/index.html"):
        raise HTTPException(422, "This URL is not the TV service's current MAG portal address. Check its host and saved link.")
    result.pop("portal_origin", None)
    return JSONResponse(result)


@app.post("/api/customers")
async def create_customer(request: Request):
    authorize(request)
    result, status = await tv_request("POST", "/admin/subscribers", await json_body(request))
    return JSONResponse(result, status_code=status)


@app.patch("/api/customers/{customer_id}")
async def update_customer(customer_id: int, request: Request):
    authorize(request)
    if customer_id < 1:
        raise HTTPException(404)
    result, _ = await tv_request("PATCH", f"/admin/subscribers/{customer_id}", await json_body(request))
    return JSONResponse(result)


@app.post("/api/customers/{customer_id}/rotate")
async def rotate_customer(customer_id: int, request: Request):
    authorize(request)
    if customer_id < 1:
        raise HTTPException(404)
    result, _ = await tv_request("POST", f"/admin/subscribers/{customer_id}/rotate")
    return JSONResponse(result)