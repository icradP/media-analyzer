#!/usr/bin/env python3
"""Capture README screenshots for example HTML pages (requires Playwright).

  pip install playwright
  playwright install chromium

Run from anywhere; paths are resolved relative to the media-analyzer package root.
"""

from __future__ import annotations

import http.server
import socket
import socketserver
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs" / "screenshots"

SHOTS: list[tuple[str, str, dict]] = [
    (
        "examples/media-overview-demo.html",
        "media-overview-demo.png",
        {"width": 1280, "height": 900, "device_scale_factor": 1},
    ),
    (
        "examples/frame-analysis-demo.html",
        "frame-analysis-demo.png",
        {"width": 1920, "height": 1080, "device_scale_factor": 1},
    ),
]


class _RootHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        del fmt, args


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return int(port)


def main() -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise SystemExit(
            "Missing playwright. Install with:\n"
            "  pip install playwright\n"
            "  playwright install chromium\n"
        ) from e

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), _RootHandler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                for rel_html, filename, viewport in SHOTS:
                    page = browser.new_page(viewport=viewport)
                    try:
                        page.goto(
                            f"{base}/{rel_html}",
                            wait_until="load",
                            timeout=120_000,
                        )
                        page.wait_for_timeout(2500)
                        dest = OUT_DIR / filename
                        page.screenshot(path=str(dest), full_page=True)
                        print(f"Wrote {dest.relative_to(ROOT)}")
                    finally:
                        page.close()
            finally:
                browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()
