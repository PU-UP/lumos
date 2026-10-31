import copy
import http.client
import json
import subprocess
import sys
import threading
import uuid

import lumos
from lumos_notes import list_notes, note_detail, save_note
from lumos_tasks import save_task, task_detail
from lumos_transfer import backup, restore
from lumos_web import make_server
from test_core import BaseStoreCase


class NoteTest(BaseStoreCase):
    def request(self, ident=None, revision=0, **changes):
        return {'request_id': uuid.uuid4().hex, 'id': ident or 'note-' + uuid.uuid4().hex,
                'expected_revision': revision, 'changes': changes or {'body': '模拟会议：核对时间同步'},
                'source': {'type': 'user', 'ref': 'fixture: synthetic meeting'}}

    def test_versions_conflicts_replay_and_unrelated_writes(self):
        req = self.request(body='原始讨论')
        first = save_note(self.store, req)['note']
        self.assertEqual(first['data']['title'], '未命名笔记')
        self.assertTrue(save_note(self.store, req)['replayed'])
        self.assertEqual(self.store.status()['seq'], 1)
        save_note(self.store, self.request(body='另一篇'))
        change = self.request(first['id'], 1, body='新讨论')
        save_note(self.store, change)
        self.assertEqual(note_detail(self.store, first['id'], 1)['note']['data']['body'], '原始讨论')
        self.assertEqual(save_note(self.store, req)['note']['data']['revision'], 1)
        with self.assertRaisesRegex(lumos.Error, '修改'):
            save_note(self.store, self.request(first['id'], 1, body='过期草稿'))
        changed = copy.deepcopy(change)
        changed['changes']['body'] = '重用请求'
        with self.assertRaisesRegex(lumos.Error, 'reused'):
            save_note(self.store, changed)
        self.assertEqual(len(note_detail(self.store, first['id'])['history']), 0)
        self.assertIsNone(self.store.status()['session'])

    def test_finish_checkpoints_and_legacy_history(self):
        req = self.request(body='旧历史')
        first = {'id': req['id'], 'kind':'note', 'data':{'title':'旧笔记', 'body':'旧历史',
                 'date':'2026-10-31', 'workspace':'lingguang', 'status':'active', 'archive_reason':'',
                 'revision':1, 'source':req['source'], 'created_at':lumos.now(), 'updated_at':lumos.now()}}
        # Simulate a pre-upgrade note using the public batch path.
        legacy = copy.deepcopy(first)
        batch = self.store.begin({'reason':'fixture legacy', 'updates':[legacy]}, True)
        self.store.commit(batch['batch'], True)
        ident = first['id']
        save_note(self.store, {**self.request(ident, 1, body='草稿一'), 'operation':'edit'})
        save_note(self.store, self.request(ident, 2, body='草稿二'))
        self.assertEqual(len(note_detail(self.store, ident)['history']), 1)
        finish = {**self.request(ident, 3), 'changes':{}, 'operation':'finish'}
        save_note(self.store, finish)
        self.assertTrue(save_note(self.store, finish)['replayed'])
        self.assertEqual(len(note_detail(self.store, ident)['history']), 2)
        self.assertEqual(note_detail(self.store, ident, 1)['note']['data']['body'], '旧历史')
        with self.assertRaises(lumos.Error):
            save_note(self.store, self.request(ident, 4, body='不允许隐式编辑'))
        save_note(self.store, {**self.request(ident, 4), 'changes':{}, 'operation':'edit'})
        save_note(self.store, self.request(ident, 5, body='第二轮'))
        save_note(self.store, {**self.request(ident, 6), 'changes':{}, 'operation':'finish'})
        self.assertEqual(len(note_detail(self.store, ident)['history']), 3)
        self.assertEqual(note_detail(self.store, ident, 4)['note']['data']['body'], '草稿二')

    def test_edit_cannot_archive_in_same_request(self):
        first = save_note(self.store, {**self.request(body='已结束'), 'operation':'finish'})['note']
        with self.assertRaises(lumos.Error):
            save_note(self.store, {**self.request(first['id'], 1, status='archived', archive_reason='已处理'), 'operation':'edit'})
        self.assertEqual(note_detail(self.store, first['id'])['note'], first)
        self.assertIsNone(self.store.status()['session'])

    def test_dates_spaces_search_archive_restore_and_context_exclusion(self):
        self.seed()
        first = save_note(self.store, self.request(title='模拟早会', body='同步问题', date='2026-10-25'))['note']
        later = save_note(self.store, self.request(title='模拟晚会', date='2026-10-26'))['note']
        save_note(self.store, self.request(workspace='lumos', body='仓库维护'))
        self.assertEqual([n['id'] for n in list_notes(self.store)['notes']], [later['id'], first['id']])
        self.assertEqual(len(list_notes(self.store, query='同步问题')['notes']), 1)
        self.assertEqual(len(list_notes(self.store, 'lumos')['notes']), 1)
        save_note(self.store, {**self.request(first['id'], 1), 'changes': {}, 'operation': 'finish'})
        save_note(self.store, self.request(first['id'], 2, status='archived', archive_reason='已整理'))
        self.assertEqual(len(list_notes(self.store)['notes']), 1)
        self.assertEqual(list_notes(self.store, archived=True)['notes'][0]['id'], first['id'])
        batch = self.store.begin({'reason': 'fixture link', 'links': [['mapping', first['id'], 'related']]}, True)
        self.store.commit(batch['batch'], True)
        self.assertNotIn(first['id'], [n['id'] for n in self.store.context('mapping')['nodes']])
        save_note(self.store, self.request(first['id'], 3, status='active', archive_reason=''))
        self.assertEqual(len(list_notes(self.store)['notes']), 2)

    def test_pinned_task_excerpt_survives_edit_archive_and_backup(self):
        self.seed()
        note = save_note(self.store, self.request(body='模拟：检查同步。另有未决问题。'))['note']
        req = {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
               'id': 'talk', 'changes': {}, 'source': {'type':'user', 'ref':'fixture: explicitly attach'},
               'note_refs': [{'id': note['id'], 'revision':1, 'excerpt':'检查同步。'}]}
        save_task(self.store, req)
        save_note(self.store, {**self.request(note['id'], 1, body='后来修订'), 'operation':'finish'})
        save_note(self.store, self.request(note['id'], 2, status='archived', archive_reason='模拟整理完毕'))
        source = task_detail(self.store, 'talk')['note_sources'][0]
        self.assertEqual(source['note']['data']['body'], '模拟：检查同步。另有未决问题。')
        self.assertEqual(source['current_status'], 'archived')
        self.assertEqual(note_detail(self.store, note['id'])['tasks'][0]['id'], 'talk')
        bad = {**req, 'request_id':uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
               'note_refs':[{'id':note['id'],'revision':1,'excerpt':'不存在的原文'}]}
        with self.assertRaisesRegex(lumos.Error, 'Excerpt'):
            save_task(self.store, bad)
        self.assertIsNone(self.store.status()['session'])
        snapshot, restored = self.area / 'snapshot', self.area / 'restore'
        backup(self.store, snapshot, True)
        restore(snapshot, restored, sandbox=True)
        self.assertEqual(task_detail(lumos.Store(restored), 'talk')['note_sources'], [source])
        result = subprocess.run([sys.executable, str(snapshot/'engine/lumos.py'), '--data', str(restored),
                                 'note', note['id'], '--revision', '1'], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['note']['data']['revision'], 1)

    def test_invalid_inputs_and_readonly_or_busy_are_not_written(self):
        for changes in [{'date':'2026-02-30'}, {'status':'archived'}, {'body':[]}, {'title':'x'*301},
                        {'body':'x'*200001}, {'workspace':'unknown'}, {'unexpected':'x'}]:
            with self.subTest(changes=list(changes)), self.assertRaises((lumos.Error, ValueError)):
                save_note(self.store, self.request(**changes))
            self.assertEqual(self.store.status()['seq'], 0)
            self.assertIsNone(self.store.status()['session'])
        batch = self.store.begin({'reason':'fixture busy'}, True)
        with self.assertRaisesRegex(lumos.Error, 'session'):
            save_note(self.store, self.request())
        self.store.abandon(batch['batch'])
        ctl=self.store.control(); ctl['mode']='readonly'; self.store.set_control(ctl)
        self.assertFalse(list_notes(self.store)['writable'])
        with self.assertRaisesRegex(lumos.Error, 'Read-only'):
            save_note(self.store, self.request())

    def test_cli_and_http_security(self):
        req = self.request(body='CLI模拟笔记')
        path = self.area/'request.json'; path.write_text(json.dumps(req), encoding='utf-8')
        result = subprocess.run([sys.executable, str(lumos.ENGINE/'lumos.py'), '--data', str(self.root),
                                 'note-save', str(path)], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        server = make_server(self.store, 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        port = server.server_port
        def call(method, path, body=None, headers=None):
            conn=http.client.HTTPConnection('127.0.0.1',port,timeout=10)
            conn.request(method,path,json.dumps(body,ensure_ascii=False).encode() if body else None,headers or {})
            res=conn.getresponse(); raw=res.read(); conn.close(); return res.status,raw
        status, raw=call('GET','/api/notes'); self.assertEqual(status,200)
        headers={'Content-Type':'application/json','Origin':f'http://127.0.0.1:{port}','X-Lumos-Token':json.loads(raw)['token']}
        req=self.request(body='中'*200000)
        status,raw=call('POST','/api/notes',req,headers); self.assertEqual(status,200,raw)
        finish = {**self.request(req['id'], 1), 'changes':{}, 'operation':'finish'}
        status,raw=call('POST','/api/notes',finish,headers); self.assertEqual(status,200,raw)
        self.assertEqual(json.loads(raw)['note']['data']['recording'], 'finished')
        for bad in ({**headers,'Origin':'https://evil.example'}, {**headers,'X-Lumos-Token':'wrong'}):
            self.assertEqual(call('POST','/api/notes',req,bad)[0],409)
        for route in ['/notes','/notes.js','/notes.css','/api/note?id='+req['id']]:
            self.assertEqual(call('GET',route)[0],200)
        self.assertEqual(call('GET','/api/note?id='+req['id']+'&revision=oops')[0],400)
