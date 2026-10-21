"""Loopback-only board. No external assets, cookies, or separate task storage."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import sqlite3
from urllib.parse import urlsplit, parse_qs

from lumos import ENGINE, Error, require
from lumos_tasks import list_tasks, task_detail, save_task


def make_server(store, port=8765):
    token = secrets.token_hex(32)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass

        def reply(self, status, body, content_type="application/json; charset=utf-8"):
            raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; "
                             "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(raw)

        def handle_request(self, write=False):
            try:
                host = f"127.0.0.1:{self.server.server_port}"
                require(self.headers.get("Host") == host, "Invalid host")
                require(self.headers.get("Sec-Fetch-Site") not in {"cross-site"}, "Cross-site request refused")
                path = urlsplit(self.path)
                if write:
                    require(path.path == "/api/tasks", "Unknown route")
                    require(self.headers.get("Origin") == "http://" + host, "Invalid origin")
                    require(secrets.compare_digest(self.headers.get("X-Lumos-Token", ""), token), "Invalid token")
                    require(self.headers.get("Content-Type", "").split(";")[0] == "application/json", "Expected JSON")
                    length = int(self.headers.get("Content-Length", "0"))
                    require(0 < length <= 1000000, "Request too large or empty")
                    request = json.loads(self.rfile.read(length))
                    require(isinstance(request, dict), "Expected request object")
                    request["source"] = {"type": "user", "ref": "本地看板用户保存，request=" + str(request.get("request_id", ""))}
                    self.reply(200, save_task(store, request))
                elif path.path == "/api/health":
                    self.reply(200, {"app": "lumos", "root": str(store.root)})
                elif path.path == "/api/tasks":
                    self.reply(200, {**list_tasks(store), "token": token})
                elif path.path == "/api/task":
                    self.reply(200, task_detail(store, parse_qs(path.query).get("id", [""])[0]))
                elif path.path in {"/", "/board.js", "/board.css"}:
                    name = {"/": "index.html", "/board.js": "board.js", "/board.css": "board.css"}[path.path]
                    content_type = {"/": "text/html", "/board.js": "text/javascript", "/board.css": "text/css"}[path.path]
                    self.reply(200, (ENGINE / "web" / name).read_bytes(), content_type + "; charset=utf-8")
                else:
                    self.reply(404, {"error": "Not found"})
            except (Error, ValueError, TypeError, KeyError, OSError, sqlite3.Error) as exc:
                self.reply(409 if isinstance(exc, Error) else 400, {"error": str(exc)})

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request(True)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def serve(store, port=8765):
    with make_server(store, port) as server:
        print(f"Lumos: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
