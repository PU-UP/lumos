import copy
import json
import uuid
from unittest.mock import patch

import lumos
from lumos_conversations import save_conversation, list_conversations, upgrade_conversations
from lumos_intake import POLICY, save_intake, claim_intake, intake_context
from lumos_transfer import backup, restore
from test_core import BaseStoreCase


class ConversationTest(BaseStoreCase):
    def setUp(self):
        super().setUp(); self.seed()
        self.source = {'type': 'user', 'ref': 'ISOLATED CONVERSATION TEST'}
        batch = self.store.begin({'reason': 'synthetic authorization', 'updates': [{'id': POLICY, 'kind': 'decision',
            'data': {'context': 'mapping', 'text': '授权', 'reason': '测试', 'scope': '测试',
                     'autonomy_workspaces': ['lingguang'], 'source': self.source}}]}, True)
        self.store.commit(batch['batch'], True)

    def request(self, **extra):
        return {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex, 'agent_role': 'librarian',
                'workspace': 'lingguang', 'title': '模拟资料核对', **extra}

    def test_metadata_replay_conflict_role_binding_and_context(self):
        request = self.request()
        first = save_conversation(self.store, request)['conversation']
        self.assertTrue(save_conversation(self.store, request)['replayed'])
        change = {**request, 'request_id': uuid.uuid4().hex, 'expected_revision': 1, 'memo': '目标：查资料；未完成：核对同步', 'source_ids': ['plan']}
        updated = save_conversation(self.store, change)['conversation']
        with self.assertRaises(lumos.Error):
            save_conversation(self.store, {**change, 'request_id': uuid.uuid4().hex})
        for field, value in [('agent_role', 'aipm'), ('workspace', 'lumos')]:
            with self.assertRaises(lumos.Error):
                save_conversation(self.store, {**change, 'request_id': uuid.uuid4().hex, 'expected_revision': 2, field: value})
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': request['chat_id'], 'text': '继续核对', 'source': self.source})['intake']
        self.assertEqual(job['data']['agent_role'], 'librarian')
        claim_intake(self.store, job['id'])
        self.assertEqual(intake_context(self.store, job['id'])['conversation'], updated)
        reopened = lumos.Store(self.root)
        self.assertEqual(list_conversations(reopened)['conversations'][0], updated)

    def test_closed_conversation_blocks_new_turns_and_can_reopen(self):
        r = self.request(); save_conversation(self.store, r)
        save_conversation(self.store, {**r, 'request_id': uuid.uuid4().hex, 'expected_revision': 1, 'status': 'closed'})
        message = {'request_id': uuid.uuid4().hex, 'chat_id': r['chat_id'], 'text': '继续', 'source': self.source}
        with self.assertRaises(lumos.Error):
            save_intake(self.store, message)
        save_conversation(self.store, {**r, 'request_id': uuid.uuid4().hex, 'expected_revision': 2, 'status': 'active'})
        self.assertEqual(save_intake(self.store, message)['intake']['data']['agent_role'], 'librarian')

    def test_upgrade_preserves_history_and_backup_restores_metadata(self):
        with self.store.db(True) as db:
            db.execute('PRAGMA user_version=1')
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex,
            'agent_role': 'aipm', 'text': '模拟历史', 'source': self.source})['intake']
        with self.assertRaises(lumos.Error):
            upgrade_conversations(self.store)
        self.assertEqual(upgrade_conversations(self.store, True)['created'], 1)
        self.assertEqual(upgrade_conversations(self.store, True)['created'], 0)
        with self.store.db() as db:
            self.assertEqual(self.store.nodes(db)[job['id']], job)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 2)
        with patch.object(lumos, 'SCHEMA', 1):
            with self.assertRaisesRegex(lumos.Error, 'Unsupported schema'):
                lumos.Store(self.root)
        snapshot = self.area/'snapshot'; backup(self.store, snapshot, True)
        target = self.area/'restored'; restore(snapshot, target, sandbox=True)
        self.assertEqual(list_conversations(lumos.Store(target)), list_conversations(self.store))
        self.assertEqual(lumos.Store(target).verify()['integrity'], 'ok')

    def test_upgrade_is_atomic_on_invalid_legacy_scope(self):
        with self.store.db(True) as db:
            db.execute('PRAGMA user_version=1')
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex,
            'text': '模拟旧消息', 'source': self.source})['intake']
        other = copy.deepcopy(job); other['id'] = 'intake-'+uuid.uuid4().hex; other['data']['workspace'] = 'lumos'
        batch = self.store.begin({'reason': 'synthetic legacy collision', 'updates': [other]}, True); self.store.commit(batch['batch'], True)
        seq = self.store.status()['seq']
        with self.assertRaisesRegex(lumos.Error, '跨资料范围'):
            upgrade_conversations(self.store, True)
        with self.store.db() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(self.store.seq(db), seq)

    def test_upgrade_keeps_unknown_role_history_read_only(self):
        with self.store.db(True) as db:
            db.execute('PRAGMA user_version=1')
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex,
            'text': '早期消息，没有确切角色记录', 'source': self.source})['intake']
        del job['data']['agent_role']
        batch = self.store.begin({'reason': 'synthetic pre-role history', 'updates': [job]}, True)
        self.store.commit(batch['batch'], True)
        upgrade_conversations(self.store, True)
        meta = list_conversations(self.store)['conversations'][0]['data']
        self.assertEqual((meta['agent_role'], meta['status']), ('legacy', 'legacy'))
        with self.store.db() as db:
            self.assertEqual(self.store.nodes(db)[job['id']], job)
