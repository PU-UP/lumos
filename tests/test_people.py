import copy
import json

import lumos
from lumos_tasks import list_tasks, save_task, task_detail
from lumos_transfer import backup, restore
from test_core import BaseStoreCase


class PeopleTest(BaseStoreCase):
    def setUp(self):
        super().setUp()
        self.seed()
        self.person = {"id": "person-test", "kind": "person", "data": {
            "title": "模拟成员", "context": "mapping", "workspaces": ["lingguang"],
            "team": "模拟平台组", "team_status": "proposed", "role": "模拟职责",
            "source": {"type": "user", "ref": "synthetic roster fixture"}}}

    def save(self, nodes):
        b = self.store.begin({"reason": "synthetic roster change", "updates": nodes}, True)
        try:
            self.store.commit(b['batch'], True)
        except Exception:
            self.store.abandon(b['batch'])
            raise

    def test_roster_without_tasks_update_archive_and_restore(self):
        before = copy.deepcopy(list_tasks(self.store)['tasks'])
        self.save([self.person])
        self.assertEqual(list_tasks(self.store)['people'], [self.person])
        self.assertEqual(list_tasks(self.store)['tasks'], before)
        self.person['data']['team'] = '模拟新组'
        self.save([self.person])
        self.assertEqual(list_tasks(self.store)['people'][0]['data']['team'], '模拟新组')
        snapshot = self.area / 'backup'
        backup(self.store, snapshot, True)
        restored = self.area / 'restored'
        restore(snapshot, restored)
        self.assertEqual(list_tasks(lumos.Store(restored))['people'], [self.person])
        self.person['data']['status'] = 'archived'
        self.save([self.person])
        self.assertEqual(list_tasks(self.store)['people'], [])
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM history WHERE node=?', ('person-test',)).fetchone()[0], 3)

    def test_invalid_and_duplicate_roster_rejected_without_changing_tasks(self):
        before = list_tasks(self.store)
        for changes in [{'workspaces': []}, {'workspaces': [['bad']]}, {'team_status': 'settled'},
                        {'title': ' 模拟成员'}, {'title': '模拟\n成员'}, {'role': []}, {'status': []}]:
            person = copy.deepcopy(self.person)
            person['data'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(lumos.Error):
                self.save([person])
            self.assertEqual(list_tasks(self.store), before)
        other = {**self.person, 'id': 'person-duplicate'}
        with self.assertRaisesRegex(lumos.Error, 'Duplicate active person'):
            self.save([self.person, other])

    def test_legacy_owner_remains_valid_and_roster_is_in_http_board(self):
        self.save([self.person])
        task = next(t for t in list_tasks(self.store)['tasks'] if t['id'] == 'talk')
        save_task(self.store, {'request_id': '9' * 32, 'expected_seq': self.store.status()['seq'],
                              'id': task['id'], 'changes': {'owner': '旧负责人', 'group': '原标签'},
                              'source': {'type': 'user', 'ref': 'synthetic legacy owner'}})
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['owner'], '旧负责人')
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['group'], '原标签')
        import http.client
        import threading
        from lumos_web import make_server
        server = make_server(self.store, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            conn.request('GET', '/api/tasks')
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())['people'], [self.person])
            for route in ('/people', '/people.js', '/people.css'):
                conn.request('GET', route)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertTrue(response.read())
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
