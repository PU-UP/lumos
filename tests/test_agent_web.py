import json
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from lumos_web import make_server
from test_core import BaseStoreCase


class AgentWebTest(BaseStoreCase):
    def test_new_routes_use_existing_loopback_and_write_guards(self):
        self.seed()
        server = make_server(self.store, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:'+str(server.server_port)
        try:
            for page in ('agents', 'knowledge', 'agents.js', 'knowledge.js', 'navigation.js', 'navigation.css', 'role-ui.js', 'role-ui.css', 'role-models.js', 'attention.js'):
                with urlopen(base+'/'+page) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
            for page in ('', 'tasks', 'notes', 'people'):
                with urlopen(base+'/'+page) as response:
                    html=response.read().decode()
                    self.assertIn('src="/role-ui.js"', html)
                    self.assertIn('src="/workspace.js"', html)
                    self.assertLess(html.index('src="/role-models.js"'), html.index('src="/role-navigation.js"'))
                    self.assertLess(html.index('src="/role-ui.js"'), html.index('src="/'+('overview' if not page else 'board' if page=='tasks' else page)+'.js"'))
            with urlopen(base+'/chat?embedded=1') as response:
                self.assertIn("frame-ancestors 'self'", response.headers['Content-Security-Policy'])
            with urlopen(base+'/chat') as response:
                self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
            with urlopen(base+'/api/knowledge?query=%E6%A0%87%E5%AE%9A') as response:
                result = json.load(response)
                self.assertEqual(result['total'], 2)
            with urlopen(base+'/api/knowledge?catalog=true') as response:
                result = json.load(response)
                self.assertEqual(set(result), {'contexts', 'token'})
                self.assertEqual(len(result['contexts']), 2)
            for route in ('materials', 'agent-inspect', 'conversation-read'):
                request = Request(base+'/api/'+route, data=b'{}', headers={'Content-Type': 'application/json', 'Origin': base})
                with self.assertRaises(HTTPError) as error:
                    urlopen(request)
                self.assertEqual(error.exception.code, 409)
            with self.assertRaises(HTTPError):
                urlopen(Request(base+'/api/agents', headers={'Sec-Fetch-Site': 'cross-site'}))
        finally:
            server.shutdown(); server.server_close(); thread.join()
