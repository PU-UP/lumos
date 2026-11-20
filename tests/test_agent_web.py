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
            for page in ('agents', 'knowledge', 'agents.js', 'knowledge.js'):
                with urlopen(base+'/'+page) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
            with urlopen(base+'/api/knowledge?query=%E6%A0%87%E5%AE%9A') as response:
                result = json.load(response)
                self.assertEqual(result['total'], 2)
            for route in ('materials', 'agent-inspect'):
                request = Request(base+'/api/'+route, data=b'{}', headers={'Content-Type': 'application/json', 'Origin': base})
                with self.assertRaises(HTTPError) as error:
                    urlopen(request)
                self.assertEqual(error.exception.code, 409)
            with self.assertRaises(HTTPError):
                urlopen(Request(base+'/api/agents', headers={'Sec-Fetch-Site': 'cross-site'}))
        finally:
            server.shutdown(); server.server_close(); thread.join()
