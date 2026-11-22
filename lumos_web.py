"""Loopback-only board. No external assets, cookies, or separate task storage."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import sqlite3
from urllib.parse import urlsplit, parse_qs

from lumos import ENGINE, Error, require
from lumos_tasks import list_tasks, task_detail, save_task
from lumos_task_review import request_task_review
from lumos_notes import list_notes, note_detail, save_note
from lumos_mainlines import mainline_detail, save_review
from lumos_intake import list_intakes, save_intake
from lumos_conversations import list_conversations, save_conversation


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
            embedded = urlsplit(self.path).path == '/chat' and parse_qs(urlsplit(self.path).query).get('embedded') == ['1']
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; "
                             "frame-ancestors " + ("'self'" if embedded else "'none'") + "; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(raw)

        def handle_request(self, write=False):
            try:
                if write:
                    length = int(self.headers.get("Content-Length", "0"))
                    require(0 < length <= 1000000, "Request too large or empty")
                    # Drain bounded bodies before rejecting headers, avoiding a TCP reset hiding the error.
                    raw = self.rfile.read(length)
                    require(len(raw) == length, "Incomplete request")
                host = f"127.0.0.1:{self.server.server_port}"
                require(self.headers.get("Host") == host, "Invalid host")
                require(self.headers.get("Sec-Fetch-Site") not in {"cross-site"}, "Cross-site request refused")
                path = urlsplit(self.path)
                if write:
                    require(path.path in {"/api/tasks", "/api/notes", "/api/intakes", "/api/mainline-review", "/api/task-review", "/api/materials", "/api/agent-inspect", "/api/conversations"}, "Unknown route")
                    require(self.headers.get("Origin") == "http://" + host, "Invalid origin")
                    require(secrets.compare_digest(self.headers.get("X-Lumos-Token", ""), token), "Invalid token")
                    require(self.headers.get("Content-Type", "").split(";")[0] == "application/json", "Expected JSON")
                    request = json.loads(raw)
                    require(isinstance(request, dict), "Expected request object")
                    request["source"] = {"type": "user", "ref": "本地看板用户保存，request=" + str(request.get("request_id", ""))}
                    from lumos_agents import inspect_once
                    from lumos_knowledge import register_material
                    save = {"/api/tasks": save_task, "/api/notes": save_note, "/api/intakes": save_intake, "/api/mainline-review": save_review, "/api/task-review": request_task_review,
                            "/api/materials": register_material, "/api/agent-inspect": inspect_once,
                            "/api/conversations": save_conversation}[path.path]
                    self.reply(200, save(store, request))
                elif path.path == "/api/agents":
                    from lumos_agents import episodes
                    self.reply(200, {**episodes(store, parse_qs(path.query).get('workspace', ['lingguang'])[0]), 'token': token,
                                     'executor': getattr(getattr(self.server, 'worker', None), 'state', 'offline')})
                elif path.path == "/api/knowledge":
                    from lumos_knowledge import search_knowledge, knowledge_catalog
                    query = parse_qs(path.query)
                    workspace = query.get('workspace', ['lingguang'])[0]
                    data = knowledge_catalog(store, workspace) if query.get('catalog') == ['true'] else search_knowledge(
                        store, workspace, query.get('query', [''])[0], query.get('archived', ['false'])[0] == 'true')
                    self.reply(200, {**data, 'token': token})
                elif path.path == "/api/materials":
                    from lumos_knowledge import material_catalog
                    self.reply(200, {'files': material_catalog(store, parse_qs(path.query).get('workspace', ['lingguang'])[0]), 'token': token})
                elif path.path == '/api/material':
                    from lumos_knowledge import material_detail
                    query = parse_qs(path.query)
                    revision = query.get('revision', [None])[0]
                    self.reply(200, material_detail(store, query.get('id', [''])[0], query.get('workspace', ['lingguang'])[0], int(revision) if revision else None))
                elif path.path == "/api/intakes":
                    query = parse_qs(path.query)
                    data = list_intakes(store, query.get("workspace", ["lingguang"])[0])
                    worker = getattr(self.server, 'worker', None)
                    self.reply(200, {**data, **list_conversations(store, query.get('workspace', ['lingguang'])[0]),
                        'executor': worker.state if worker else 'offline', 'token': token})
                elif path.path == '/api/conversations':
                    self.reply(200, {**list_conversations(store, parse_qs(path.query).get('workspace', ['lingguang'])[0]), 'token': token})
                elif path.path == "/api/codex-models":
                    from lumos_worker import codex_models
                    self.reply(200, codex_models())
                elif path.path == "/api/notes":
                    query = parse_qs(path.query)
                    self.reply(200, {**list_notes(store, query.get("workspace", ["lingguang"])[0],
                                                 query.get("archived", ["false"])[0] == "true",
                                                 query.get("query", [""])[0]), "token": token})
                elif path.path == "/api/note":
                    query = parse_qs(path.query)
                    revision = query.get("revision", [None])[0]
                    self.reply(200, note_detail(store, query.get("id", [""])[0], int(revision) if revision else None))
                elif path.path == "/api/health":
                    self.reply(200, {"app": "lumos", "root": str(store.root), 'preview': (store.root/'PREVIEW').is_file(), 'role_spaces': True})
                elif path.path in {'/role-navigation.js', '/role-navigation.css', '/role-chat.js', '/role-reports.js', '/role-reports.css', '/role-knowledge.js', '/role-knowledge.css', '/role-ui.js', '/role-ui.css', '/workspace.js', '/workspace.css'}:
                    name = path.path[1:]
                    self.reply(200, (ENGINE/'web'/name).read_bytes(),
                               ('text/javascript' if name.endswith('.js') else 'text/css')+'; charset=utf-8')
                elif path.path == "/api/tasks":
                    self.reply(200, {**list_tasks(store), "token": token, "executor": getattr(getattr(self.server, "worker", None), "state", "offline")})
                elif path.path == "/api/task":
                    self.reply(200, task_detail(store, parse_qs(path.query).get("id", [""])[0]))
                elif path.path == "/api/mainline":
                    self.reply(200, mainline_detail(store, parse_qs(path.query).get("id", [""])[0]))
                elif path.path in {"/", "/tasks", "/delivery", "/disclosure.js", "/intake.js", "/overview.js", "/work-model.js", "/dialog.js", "/overview.css", "/board.js", "/board.css", "/notes", "/notes.js", "/notes.css", "/people", "/people.js", "/people.css", "/chat", "/chat.js", "/chat.css", "/agents", "/agents.js", "/agents.css", "/knowledge", "/knowledge.js", "/navigation.js", "/navigation.css"}:
                    name = {"/": "overview.html", "/delivery": "overview.html", "/tasks": "index.html", "/notes": "notes.html", "/people": "people.html", "/chat": "chat.html", "/agents": "agents.html", "/knowledge": "knowledge.html"}.get(path.path, path.path[1:])
                    if path.path == "/" and "task" in parse_qs(path.query):
                        name = "index.html"  # Preserve existing task bookmarks.
                    content_type = "text/javascript" if name.endswith(".js") else "text/css" if name.endswith(".css") else "text/html"
                    if name == 'chat.html':
                        name = 'role-chat.html'
                    if name == 'agents.html':
                        name = 'role-reports.html'
                    if name == 'knowledge.html':
                        name = 'role-knowledge.html'
                    raw = (ENGINE / 'web' / name).read_bytes()
                    if name.endswith('.html'):
                        raw = raw.replace(b'/navigation.js', b'/role-navigation.js').replace(b'/navigation.css', b'/role-navigation.css')
                        raw = raw.replace(b'</head>', b'<link rel="stylesheet" href="/workspace.css"><script src="/workspace.js" defer></script></head>')
                        if name in {'overview.html', 'index.html', 'notes.html', 'people.html'}:
                            raw = raw.replace(b'<script src="/role-navigation.js" defer></script>', b'<script src="/role-navigation.js" defer></script><script src="/role-ui.js" defer></script>')
                            raw = raw.replace(b'</head>', b'<link rel="stylesheet" href="/role-ui.css"></head>')
                    self.reply(200, raw, content_type + "; charset=utf-8")
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
        from lumos_worker import Worker
        server.worker = Worker(store)
        server.worker.thread.start()
        print(f"Lumos: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.worker.stop.set()
