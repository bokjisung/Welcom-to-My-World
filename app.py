#!/usr/bin/env python3
from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
IS_RAILWAY = bool(
    os.environ.get("RAILWAY_PROJECT_ID")
    or os.environ.get("RAILWAY_SERVICE_ID")
    or os.environ.get("RAILWAY_ENVIRONMENT_NAME")
)
VOLUME_MOUNT = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "").strip()
EXPLICIT_DATA_DIR = os.environ.get("GABAE_DATA_DIR", "").strip()
ALLOW_EPHEMERAL = os.environ.get("GABAE_ALLOW_EPHEMERAL", "").strip() == "1"
ALLOW_PUBLIC = os.environ.get("GABAE_ALLOW_PUBLIC", "").strip() == "1"
AUTH_USERNAME = os.environ.get("GABAE_AUTH_USERNAME", "gabae").strip() or "gabae"
AUTH_PASSWORD = os.environ.get("GABAE_AUTH_PASSWORD", "")

if EXPLICIT_DATA_DIR:
    DATA_DIR = Path(EXPLICIT_DATA_DIR).expanduser().resolve()
elif VOLUME_MOUNT:
    DATA_DIR = Path(VOLUME_MOUNT).resolve()
else:
    DATA_DIR = BASE_DIR / "data"

if IS_RAILWAY and not (VOLUME_MOUNT or EXPLICIT_DATA_DIR) and not ALLOW_EPHEMERAL:
    raise RuntimeError(
        "Railway 환경에서 영구 저장 Volume이 없습니다. 서비스에 Volume을 추가하고 "
        "mount path를 /data 로 설정하세요. 임시 저장을 의도한 경우에만 "
        "GABAE_ALLOW_EPHEMERAL=1 을 설정하세요."
    )

if IS_RAILWAY and not AUTH_PASSWORD and not ALLOW_PUBLIC:
    raise RuntimeError(
        "공개 Railway 배포에는 접근 암호가 필요합니다. GABAE_AUTH_PASSWORD를 설정하세요. "
        "완전 공개 운영을 의도한 경우에만 GABAE_ALLOW_PUBLIC=1 을 설정하세요."
    )

DB_PATH = DATA_DIR / "gabae.db"
IMAGE_DIR = DATA_DIR / "images"
DB_LOCK = threading.RLock()

MAX_STATE_BODY_BYTES = 3 * 1024 * 1024
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_ITEMS = 500
MAX_SITES = 200
HISTORY_LIMIT = 100
ORPHAN_GRACE_SECONDS = 24 * 60 * 60
IMAGE_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp)$")
IMAGE_URL_RE = re.compile(r"^/api/images/([0-9a-f]{32}\.(?:jpg|png|webp))$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LEGACY_DATA_IMAGE_RE = re.compile(
    r"^data:image/(jpeg|jpg|png|webp);base64,(.+)$", re.IGNORECASE | re.DOTALL
)

DEFAULT_STATE = {
    "orderDate": "",
    "items": [
        {
            "id": "initial-item",
            "name": "",
            "quantity": 1,
            "unit": "개",
            "price": 0,
            "note": "",
            "image": "",
        }
    ],
    "sites": [{"id": "default-coupang", "name": "쿠팡", "url": "coupang.com"}],
}

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state_history (
    version INTEGER PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT NOT NULL
);
"""

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_BYTES + 1024 * 1024
app.config["JSON_AS_ASCII"] = False


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    with DB_LOCK, db_connect() as conn:
        conn.executescript(SCHEMA_SQL)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        row = conn.execute("SELECT id FROM app_state WHERE id = 1").fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO app_state (id, state_json, version, updated_at) VALUES (1, ?, 1, ?)",
                (json.dumps(DEFAULT_STATE, ensure_ascii=False), utc_now_iso()),
            )
        conn.commit()
    migrate_legacy_embedded_images()


def parse_state_json(raw: str) -> dict[str, Any]:
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("저장된 state_json 형식이 올바르지 않습니다.")
    return parsed


def read_state() -> dict[str, Any]:
    with DB_LOCK, db_connect() as conn:
        row = conn.execute(
            "SELECT state_json, version, updated_at FROM app_state WHERE id = 1"
        ).fetchone()
    if row is None:
        ensure_storage()
        return read_state()
    return {
        "state": parse_state_json(row["state_json"]),
        "version": int(row["version"]),
        "updatedAt": row["updated_at"],
    }


def _is_str(value: Any, max_len: int, allow_empty: bool = True) -> bool:
    if not isinstance(value, str):
        return False
    if len(value) > max_len:
        return False
    return allow_empty or bool(value.strip())


def validate_state(state: Any) -> str | None:
    if not isinstance(state, dict):
        return "state는 객체여야 합니다."

    order_date = state.get("orderDate", "")
    if not isinstance(order_date, str) or (order_date and not DATE_RE.fullmatch(order_date)):
        return "발주일 형식이 올바르지 않습니다."

    items = state.get("items")
    sites = state.get("sites")
    if not isinstance(items, list):
        return "items는 배열이어야 합니다."
    if not isinstance(sites, list):
        return "sites는 배열이어야 합니다."
    if len(items) > MAX_ITEMS:
        return f"품목은 최대 {MAX_ITEMS}개까지 저장할 수 있습니다."
    if len(sites) > MAX_SITES:
        return f"사이트는 최대 {MAX_SITES}개까지 저장할 수 있습니다."

    allowed_units = {"개", "박스", "팩", "봉", "병", "통", "세트", "kg", "g", "L", "mL"}
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            return f"{index}번 품목 형식이 올바르지 않습니다."
        if not _is_str(item.get("id", ""), 100, allow_empty=False):
            return f"{index}번 품목 id가 올바르지 않습니다."
        if not _is_str(item.get("name", ""), 120):
            return f"{index}번 품목명이 너무 깁니다."
        if not _is_str(item.get("note", ""), 500):
            return f"{index}번 메모가 너무 깁니다."
        if item.get("unit") not in allowed_units:
            return f"{index}번 단위가 올바르지 않습니다."
        quantity = item.get("quantity", 0)
        price = item.get("price", 0)
        if not isinstance(quantity, (int, float)) or isinstance(quantity, bool) or quantity < 0 or quantity > 1_000_000:
            return f"{index}번 수량이 올바르지 않습니다."
        if not isinstance(price, (int, float)) or isinstance(price, bool) or price < 0 or price > 10_000_000_000:
            return f"{index}번 가격이 올바르지 않습니다."
        image = item.get("image", "")
        if not isinstance(image, str):
            return f"{index}번 사진 정보가 올바르지 않습니다."
        if image and not IMAGE_URL_RE.fullmatch(image):
            return f"{index}번 사진 주소가 올바르지 않습니다. 사진을 다시 선택해주세요."

    for index, site in enumerate(sites, start=1):
        if not isinstance(site, dict):
            return f"{index}번 사이트 형식이 올바르지 않습니다."
        if not _is_str(site.get("id", ""), 100, allow_empty=False):
            return f"{index}번 사이트 id가 올바르지 않습니다."
        if not _is_str(site.get("name", ""), 80):
            return f"{index}번 사이트 이름이 너무 깁니다."
        if not _is_str(site.get("url", ""), 500):
            return f"{index}번 사이트 주소가 너무 깁니다."

    return None


def write_state(state: Any, expected_version: Any) -> dict[str, Any]:
    validation_error = validate_state(state)
    if validation_error:
        return {"status": "invalid", "error": validation_error}

    try:
        parsed_expected = int(expected_version)
    except (TypeError, ValueError):
        return {"status": "invalid", "error": "version 값이 필요합니다."}
    if parsed_expected < 0:
        return {"status": "invalid", "error": "version 값이 올바르지 않습니다."}

    encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_STATE_BODY_BYTES:
        return {"status": "invalid", "error": "발주 데이터가 너무 큽니다."}

    now = utc_now_iso()
    with DB_LOCK, db_connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT state_json, version, updated_at FROM app_state WHERE id = 1"
        ).fetchone()
        if row is None:
            conn.rollback()
            return {"status": "error", "error": "저장 데이터가 초기화되지 않았습니다."}

        current_version = int(row["version"])
        if parsed_expected != current_version:
            conn.rollback()
            return {
                "status": "conflict",
                "state": parse_state_json(row["state_json"]),
                "version": current_version,
                "updatedAt": row["updated_at"],
            }

        conn.execute(
            "INSERT OR IGNORE INTO app_state_history "
            "(version, state_json, updated_at, archived_at) VALUES (?, ?, ?, ?)",
            (current_version, row["state_json"], row["updated_at"], now),
        )
        new_version = current_version + 1
        conn.execute(
            "UPDATE app_state SET state_json = ?, version = ?, updated_at = ? WHERE id = 1",
            (encoded, new_version, now),
        )
        conn.execute(
            "DELETE FROM app_state_history WHERE version NOT IN "
            "(SELECT version FROM app_state_history ORDER BY version DESC LIMIT ?)",
            (HISTORY_LIMIT,),
        )
        conn.commit()

    cleanup_orphan_images(state)
    return {"status": "ok", "version": new_version, "updatedAt": now}


def image_references(state: dict[str, Any]) -> set[str]:
    refs: set[str] = set()
    for item in state.get("items", []):
        if not isinstance(item, dict):
            continue
        image = item.get("image", "")
        if not isinstance(image, str):
            continue
        match = IMAGE_URL_RE.fullmatch(image)
        if match:
            refs.add(match.group(1))
    return refs


def cleanup_orphan_images(state: dict[str, Any]) -> None:
    # Keep files referenced by the current state and by retained history so that
    # a DB-level rollback does not immediately point at deleted images.
    referenced = image_references(state)
    try:
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT state_json FROM app_state_history ORDER BY version DESC LIMIT ?",
                (HISTORY_LIMIT,),
            ).fetchall()
        for row in rows:
            try:
                referenced.update(image_references(parse_state_json(row["state_json"])))
            except (ValueError, json.JSONDecodeError):
                continue
    except sqlite3.Error:
        pass

    cutoff = time.time() - ORPHAN_GRACE_SECONDS
    try:
        for pattern in ("*.jpg", "*.png", "*.webp"):
            for path in IMAGE_DIR.glob(pattern):
                if path.name in referenced:
                    continue
                try:
                    if path.stat().st_mtime < cutoff:
                        path.unlink(missing_ok=True)
                except OSError:
                    continue
    except OSError:
        return


def _legacy_extension(mime: str) -> str:
    mime = mime.lower()
    if mime in {"jpeg", "jpg"}:
        return "jpg"
    if mime == "png":
        return "png"
    return "webp"


def migrate_legacy_embedded_images() -> None:
    """Convert old base64 images from the v1 database into volume-backed files."""
    with DB_LOCK, db_connect() as conn:
        row = conn.execute(
            "SELECT state_json, version, updated_at FROM app_state WHERE id = 1"
        ).fetchone()
        if row is None:
            return
        try:
            state = parse_state_json(row["state_json"])
        except (ValueError, json.JSONDecodeError):
            return

        changed = False
        created_files: list[Path] = []
        try:
            for item in state.get("items", []):
                if not isinstance(item, dict):
                    continue
                image = item.get("image", "")
                if not isinstance(image, str) or not image.startswith("data:image/"):
                    continue
                match = LEGACY_DATA_IMAGE_RE.match(image)
                if not match:
                    continue
                try:
                    raw = base64.b64decode(match.group(2), validate=True)
                except (binascii.Error, ValueError):
                    continue
                if not raw or len(raw) > MAX_IMAGE_BYTES:
                    continue
                ext = _legacy_extension(match.group(1))
                filename = f"{uuid.uuid4().hex}.{ext}"
                target = IMAGE_DIR / filename
                temp = IMAGE_DIR / f".{filename}.tmp"
                temp.write_bytes(raw)
                os.replace(temp, target)
                created_files.append(target)
                item["image"] = f"/api/images/{filename}"
                changed = True

            if not changed:
                return

            now = utc_now_iso()
            current_version = int(row["version"])
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT OR IGNORE INTO app_state_history "
                "(version, state_json, updated_at, archived_at) VALUES (?, ?, ?, ?)",
                (current_version, row["state_json"], row["updated_at"], now),
            )
            conn.execute(
                "UPDATE app_state SET state_json = ?, version = ?, updated_at = ? WHERE id = 1",
                (
                    json.dumps(state, ensure_ascii=False, separators=(",", ":")),
                    current_version + 1,
                    now,
                ),
            )
            conn.commit()
        except Exception:
            for path in created_files:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise


def auth_enabled() -> bool:
    return bool(AUTH_PASSWORD)


def unauthorized() -> Response:
    response = jsonify({"error": "인증이 필요합니다."})
    response.status_code = 401
    response.headers["WWW-Authenticate"] = 'Basic realm="Gabae Order Manager", charset="UTF-8"'
    return response


@app.before_request
def require_auth():
    if request.path == "/api/health" or not auth_enabled():
        return None
    auth = request.authorization
    if not auth:
        return unauthorized()
    username_ok = hmac.compare_digest(auth.username or "", AUTH_USERNAME)
    password_ok = hmac.compare_digest(auth.password or "", AUTH_PASSWORD)
    if not (username_ok and password_ok):
        return unauthorized()
    return None


@app.after_request
def security_headers(response: Response) -> Response:
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    if request.path == "/" or request.path.endswith(".html"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    elif request.path.startswith("/api/") and not request.path.startswith("/api/images/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
def health():
    try:
        with db_connect() as conn:
            row = conn.execute("SELECT version FROM app_state WHERE id = 1").fetchone()
        healthy = row is not None and DATA_DIR.exists() and os.access(DATA_DIR, os.W_OK)
        payload = {
            "ok": bool(healthy),
            "database": DB_PATH.name,
            "storage": str(DATA_DIR),
            "persistentVolume": bool(VOLUME_MOUNT or EXPLICIT_DATA_DIR),
        }
        return jsonify(payload), 200 if healthy else 503
    except Exception as exc:
        return jsonify({"ok": False, "error": type(exc).__name__}), 503


@app.get("/api/state")
def get_state():
    return jsonify(read_state())


@app.put("/api/state")
def put_state():
    if request.content_length is None or request.content_length <= 0:
        return jsonify({"error": "요청 내용이 비어 있습니다."}), 400
    if request.content_length > MAX_STATE_BODY_BYTES:
        return jsonify({"error": "발주 데이터가 너무 큽니다."}), 413
    if not request.is_json:
        return jsonify({"error": "Content-Type은 application/json이어야 합니다."}), 415

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON 형식이 올바르지 않습니다."}), 400
    result = write_state(payload.get("state"), payload.get("version"))

    if result["status"] == "conflict":
        return jsonify(
            {
                "error": "다른 사용자가 먼저 저장했습니다.",
                "state": result["state"],
                "version": result["version"],
                "updatedAt": result["updatedAt"],
            }
        ), 409
    if result["status"] == "invalid":
        return jsonify({"error": result["error"]}), 400
    if result["status"] != "ok":
        return jsonify({"error": result.get("error", "저장 중 오류가 발생했습니다.")}), 500
    return jsonify({"ok": True, "version": result["version"], "updatedAt": result["updatedAt"]})


@app.put("/api/images/<filename>")
def put_image(filename: str):
    if not IMAGE_NAME_RE.fullmatch(filename):
        return jsonify({"error": "사진 파일 이름이 올바르지 않습니다."}), 400
    if request.content_type != "image/jpeg":
        return jsonify({"error": "JPEG 사진만 업로드할 수 있습니다."}), 415
    if request.content_length is None or request.content_length <= 0:
        return jsonify({"error": "사진 데이터가 비어 있습니다."}), 400
    if request.content_length > MAX_IMAGE_BYTES:
        return jsonify({"error": "사진 용량이 너무 큽니다."}), 413

    raw = request.get_data(cache=False)
    if len(raw) > MAX_IMAGE_BYTES:
        return jsonify({"error": "사진 용량이 너무 큽니다."}), 413
    if len(raw) < 4 or not raw.startswith(b"\xff\xd8") or not raw.endswith(b"\xff\xd9"):
        return jsonify({"error": "JPEG 파일 형식이 올바르지 않습니다."}), 400

    target = IMAGE_DIR / filename
    temp = IMAGE_DIR / f".{filename}.{uuid.uuid4().hex}.tmp"
    temp.write_bytes(raw)
    os.replace(temp, target)
    return jsonify({"ok": True, "url": f"/api/images/{filename}"})


@app.get("/api/images/<filename>")
def get_image(filename: str):
    if not IMAGE_NAME_RE.fullmatch(filename):
        return jsonify({"error": "사진 파일 이름이 올바르지 않습니다."}), 400
    response = send_from_directory(IMAGE_DIR, filename, conditional=True)
    response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    return response


@app.get("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename: str):
    if filename.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(PUBLIC_DIR, filename)


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(PUBLIC_DIR, "index.html"), 404


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "요청 데이터가 너무 큽니다."}), 413


ensure_storage()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", os.environ.get("GABAE_PORT", "8000")))
    host = os.environ.get("GABAE_HOST", "0.0.0.0")
    app.run(host=host, port=port, threaded=True)
