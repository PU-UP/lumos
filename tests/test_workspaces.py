import copy
import json
import threading
import uuid
from urllib.request import urlopen, Request

import lumos
from lumos_workspaces import unify_workspace, is_unified
from lumos_conversations import upgrade_conversations
from lumos_tasks import list_tasks, task_numbers
from lumos_notes import save_note, note_version
from lumos_web import make_server
from test_core import BaseStoreCase


class WorkspaceTest(BaseStoreCase):
    def setUp(self):
        super().setUp(); self.seed()
        self.source = {'type': 'user', 'ref': 'SYNTHETIC UNIFICATION CHECK'}
        with self.store.db() as db:
            nodes = self.store.nodes(db)
        context = copy.deepcopy(nodes['mapping']); context['data']['workspace'] = 'lumos'
        job = {'id': 'old-intake', 'kind': 'intake', 'data': {'workspace': 'lumos', 'status': 'done',
            'revision': 1, 'created_at': '2026-11-22T00:00:00Z', 'updated_at': '2026-11-22T00:00:00Z',
            'title': '旧记录', 'text': '保留原话', 'summary': '原结论', 'source': self.source}}
        policy = {'id': 'lumos-autonomy-policy', 'kind': 'decision', 'data': {'context': 'mapping',
            'text': '测试授权', 'source': self.source, 'reason': '测试', 'scope': '模拟',
            'autonomy_workspaces': ['lingguang', 'lumos'], 'task_management_workspaces': ['lumos']}}
        b = self.store.begin({'reason': 'synthetic old split', 'updates': [context, job, policy]}, True)
        self.store.commit(b['batch'], True)

    def test_unification_preserves_work_content_history_numbers_and_is_idempotent(self):
        import uuid
        note = save_note(self.store, {'request_id': uuid.uuid4().hex, 'id': 'note-'+uuid.uuid4().hex,
            'expected_revision': 0, 'changes': {'workspace': 'lumos', 'title': '旧笔记', 'body': '确切正文'}, 'source': self.source})['note']
        with self.store.db() as db:
            before = self.store.nodes(db); numbers = task_numbers(db)
            history = db.execute('SELECT * FROM history').fetchall()
        with self.assertRaises(lumos.Error):
            unify_workspace(self.store)
        result = unify_workspace(self.store, True)
        with self.store.db() as db:
            after = self.store.nodes(db)
            self.assertEqual(task_numbers(db), numbers)
            self.assertEqual(db.execute('SELECT * FROM history').fetchall()[:len(history)], history)
            self.assertEqual(note_version(db, note['id'], note['data']['revision']), note)
        self.assertTrue(is_unified(after))
        self.assertEqual(after['talk'], before['talk'])
        self.assertEqual(after[note['id']]['data']['body'], note['data']['body'])
        self.assertEqual(after['mapping']['data']['workspace'], 'lingguang')
        self.assertEqual(after['old-intake']['data']['text'], '保留原话')
        self.assertEqual(after['old-intake']['data']['workspace'], 'lingguang')
        self.assertEqual(unify_workspace(self.store, True)['changed'], 0)
        self.assertGreater(result['changed'], 0)

    def test_unified_http_old_scope_aliases_and_bootstrap_precedes_scripts(self):
        unify_workspace(self.store, True); upgrade_conversations(self.store, True)
        server = make_server(self.store, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:'+str(server.server_port)
        try:
            with urlopen(base+'/api/intakes?workspace=lumos') as r:
                data = json.load(r)
            self.assertIn('old-intake', [n['id'] for n in data['intakes']])
            body = json.dumps({'request_id': uuid.uuid4().hex, 'workspace': 'lumos', 'text': '旧入口继续交流'}).encode()
            with urlopen(Request(base+'/api/intakes', data=body, headers={'Content-Type': 'application/json',
                    'Origin': base, 'X-Lumos-Token': data['token']})) as r:
                self.assertEqual(json.load(r)['intake']['data']['workspace'], 'lingguang')
            with urlopen(base+'/workspace-mode.js') as r:
                script = r.read().decode()
                self.assertIn('window.LumosUnified=true', script)
            with urlopen(base+'/chat?workspace=lumos') as r:
                html = r.read().decode()
                self.assertLess(html.index('/workspace-mode.js'), html.index('/role-navigation.js'))
                self.assertLess(html.index('/role-navigation.js'), html.index('/attention.js'))
                self.assertLess(html.index('/attention.js'), html.index('/role-chat.js'))
                self.assertEqual(html.count('src="/attention.js"'), 1)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_pending_input_refuses_without_leaving_a_session(self):
        with self.store.db() as db:
            job = self.store.nodes(db)['old-intake']
        job['data']['status'] = 'pending'
        b = self.store.begin({'reason': 'synthetic pending', 'updates': [job]}, True); self.store.commit(b['batch'], True)
        seq = self.store.status()['seq']
        with self.assertRaises(lumos.Error):
            unify_workspace(self.store, True)
        self.assertEqual(self.store.status()['seq'], seq)
        self.assertIsNone(self.store.status()['session'])
