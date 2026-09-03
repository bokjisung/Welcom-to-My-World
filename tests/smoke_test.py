#!/usr/bin/env python3
import importlib
import json
import os
import tempfile
from pathlib import Path


def minimal_jpeg():
    # API validates only JPEG SOI/EOI; enough for endpoint transport smoke testing.
    return b"\xff\xd8SMOKE\xff\xd9"


def run():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["GABAE_DATA_DIR"] = tmp
        os.environ.pop("RAILWAY_PROJECT_ID", None)
        os.environ.pop("RAILWAY_SERVICE_ID", None)
        os.environ.pop("RAILWAY_ENVIRONMENT_NAME", None)
        os.environ.pop("GABAE_AUTH_PASSWORD", None)
        module = importlib.import_module("app")
        client = module.app.test_client()

        health = client.get("/api/health")
        assert health.status_code == 200, health.data

        first = client.get("/api/state")
        assert first.status_code == 200
        payload = first.get_json()
        version = payload["version"]
        state = payload["state"]

        image_name = "0123456789abcdef0123456789abcdef.jpg"
        uploaded = client.put(
            f"/api/images/{image_name}", data=minimal_jpeg(), content_type="image/jpeg"
        )
        assert uploaded.status_code == 200, uploaded.data
        assert Path(tmp, "images", image_name).exists()

        state["items"][0]["name"] = "테스트 품목"
        state["items"][0]["image"] = f"/api/images/{image_name}"
        saved = client.put("/api/state", json={"version": version, "state": state})
        assert saved.status_code == 200, saved.data
        next_version = saved.get_json()["version"]
        assert next_version == version + 1

        conflict = client.put("/api/state", json={"version": version, "state": state})
        assert conflict.status_code == 409, conflict.data

        reloaded = client.get("/api/state").get_json()
        assert reloaded["state"]["items"][0]["name"] == "테스트 품목"
        assert reloaded["state"]["items"][0]["image"].endswith(image_name)

        image = client.get(f"/api/images/{image_name}")
        assert image.status_code == 200

        with module.db_connect() as conn:
            history_count = conn.execute("SELECT COUNT(*) FROM app_state_history").fetchone()[0]
        assert history_count >= 1

        print("SMOKE TEST PASS")


if __name__ == "__main__":
    run()
