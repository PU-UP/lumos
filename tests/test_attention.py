import copy
import uuid
from unittest.mock import patch

import lumos
from lumos_attention import synchronize_attention, read_attention, validate_notices
from lumos_conversations import list_conversations, save_conversation
from lumos_intake import POLICY, save_intake, claim_intake, intake_context, apply_intake
from lumos_tasks import save_task
from test_core import BaseStoreCase


class AttentionTest(BaseStoreCase):
    def setUp(self):
        super().setUp(); self.seed()
        self.source = {'type': 'user', 'ref': 'ISOLATED ATTENTION TEST'}
        batch = self.store.begin({'reason': 'synthetic authorization', 'updates': [{'id': POLICY, 'kind': 'decision',
            'data': {'context': 'mapping', 'text': '授权', 'reason': '测试', 'scope': '测试',
                     'autonomy_workspaces': ['lingguang'], 'source': self.source}}]}, True)
        self.store.commit(batch['batch'], True)

    def chats(self):
        return list_conversations(self.store)['conversations']

    def job(self, role='lumos', **extra):
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex,
            'agent_role': role, 'text': '模拟：讨论同步条件', 'related_ids': ['talk'], 'source': self.source, **extra})['intake']
        claim = claim_intake(self.store, job['id'])
        return {'id': job['id'], 'claim': claim['data']['claim'], 'basis': intake_context(self.store, job['id'])['basis'],
                'plan': {'updates': [], 'questions': [], 'resolutions': [], 'summary': '仅讨论同步条件', 'reply': '同步条件仍需核对。',
                         'conversation': {'title': '同步条件核对', 'memo': '待核对实际同步结果。', 'state': 'settled'}}}

    def test_agent_title_memo_reply_atomic_manual_rename_protected_and_settled_continues(self):
        request = self.job(); apply_intake(self.store, request)
        chat = self.chats()[0]; d = chat['data']
        self.assertEqual(d['title'], '同步条件核对'); self.assertEqual(d['topic_state'], 'settled')
        self.assertEqual(d['memo'], '待核对实际同步结果。'); self.assertEqual(len(d['notices']), 1)
        self.assertTrue(apply_intake(self.store, request)['replayed'])
        next_job = self.job(chat_id=d['chat_id'], chat_parent=request['id'])
        save_conversation(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': d['chat_id'], 'title': '我起的名字', 'expected_revision': d['revision']})
        next_job['plan']['conversation']['title'] = 'Agent 的新名字'
        apply_intake(self.store, next_job)
        latest = self.chats()[0]['data']; self.assertEqual(latest['title'], '我起的名字'); self.assertEqual(len(latest['notices']), 2)
        # An old visible message read receipt cannot swallow a later reply.
        read_attention(self.store, {'chat_id': d['chat_id'], 'workspace': 'lingguang', 'ids': [d['notices'][0]['id']]})
        notices = self.chats()[0]['data']['notices']; self.assertTrue(notices[0]['seen_at']); self.assertFalse(notices[1]['seen_at'])
        seq = self.store.status()['seq']
        read_attention(self.store, {'chat_id': d['chat_id'], 'workspace': 'lingguang', 'ids': [d['notices'][0]['id']]})
        self.assertEqual(self.store.status()['seq'], seq)
        self.assertEqual(list_conversations(lumos.Store(self.root)), list_conversations(self.store))

    def test_questions_route_to_lumos_deduplicate_and_read_does_not_resolve(self):
        request = self.job('aipm'); request['plan']['questions'] = ['实际同步误差是多少？']
        from lumos_worker import collaborate
        from lumos_agents import prepare_execution
        context = intake_context(self.store, request['id'])
        plan = request['plan']
        request['plan'] = collaborate(self.store, context['intake'], context, lambda *args: copy.deepcopy(plan))
        prepare_execution(self.store, request['id'], request['claim'], request['plan'])
        apply_intake(self.store, request); self.assertEqual(synchronize_attention(self.store), 1)
        chat = next(c for c in self.chats() if c['data']['agent_role'] == 'lumos'); item = chat['data']['notices'][0]
        self.assertEqual(item['question_key'], 'question:'+request['id']+':0')
        self.assertEqual(synchronize_attention(self.store), 0)
        read_attention(self.store, {'chat_id': chat['data']['chat_id'], 'workspace': 'lingguang', 'ids': [item['id']]})
        context = intake_context(self.store, request['id']); self.assertTrue(context['open_questions'])
        self.assertEqual(synchronize_attention(self.store), 0)
        answer = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': chat['data']['chat_id'],
            'text': '暂时还没有结果', 'question_key': item['question_key'], 'source': self.source})['intake']
        synchronize_attention(self.store)
        latest = next(c for c in self.chats() if c['id'] == chat['id'])
        self.assertFalse(latest['data']['notices'][0]['active'])
        self.assertEqual(answer['data']['agent_role'], 'lumos')

    def test_missing_metadata_keeps_memo_and_invalid_metadata_cannot_partially_commit(self):
        request = self.job(); apply_intake(self.store, request)
        chat = self.chats()[0]['data']
        next_job = self.job(chat_id=chat['chat_id'], chat_parent=request['id'])
        next_job['plan']['conversation']['state'] = 'invalid'
        seq = self.store.status()['seq']
        with self.assertRaises(lumos.Error):
            apply_intake(self.store, next_job)
        self.assertEqual(self.store.status()['seq'], seq)
        next_job['plan'].pop('conversation'); apply_intake(self.store, next_job)
        self.assertEqual(self.chats()[0]['data']['memo'], chat['memo'])
        self.assertEqual(self.chats()[0]['data']['topic_state'], 'settled')

    def test_delivered_messages_are_immutable_and_survive_task_scope_changes(self):
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
            'id': 'talk', 'changes': {'follow_up': '2026-11-22'}, 'source': self.source})
        with patch('lumos_intake.today', return_value='2026-11-22'):
            synchronize_attention(self.store)
        chat = self.chats()[0]; item = copy.deepcopy(chat['data']['notices'][0])
        with self.store.db() as db:
            nodes = self.store.nodes(db)
        forged = {**item, 'text': '改写已经送达的消息'}
        with self.assertRaises(lumos.Error):
            validate_notices([forged], 'lumos', 'lingguang', nodes, [item])
        prep = copy.deepcopy(nodes['prep']); prep['data']['workspace'] = 'lumos'
        batch = self.store.begin({'reason': 'synthetic second workspace', 'updates': [prep]}, True); self.store.commit(batch['batch'], True)
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
            'id': 'talk', 'changes': {'context': 'prep'}, 'source': self.source})
        read_attention(self.store, {'chat_id': chat['data']['chat_id'], 'workspace': 'lingguang', 'ids': [item['id']]})
        synchronize_attention(self.store)
        self.assertFalse(self.chats()[0]['data']['notices'][0]['active'])
        self.assertEqual(self.chats()[0]['data']['notices'][0]['text'], item['text'])
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_due_followup_and_ops_have_exact_sources_no_repeat_or_cross_scope(self):
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
            'id': 'talk', 'changes': {'follow_up': '2026-11-22'}, 'source': self.source})
        issue_job = self.job('maintainer'); apply_intake(self.store, issue_job)
        issue = {'key': 'synthetic', 'status': 'detected', 'summary': '模拟权限异常', 'impact': '原输入已保留', 'episode_id': issue_job['id'], 'title': '运行检查'}
        with patch('lumos_intake.today', return_value='2026-11-22'), patch('lumos_ops.issue_groups', return_value=[issue]):
            synchronize_attention(self.store); self.assertEqual(synchronize_attention(self.store), 0)
        chats = self.chats()
        follow = next(c for c in chats if any(i['kind'] == 'followup' for i in c['data'].get('notices', [])))
        ops = next(c for c in chats if any(i['kind'] == 'ops' for i in c['data'].get('notices', [])))
        self.assertEqual(follow['data']['agent_role'], 'lumos'); self.assertEqual(ops['data']['agent_role'], 'maintainer')
        with self.assertRaises(lumos.Error):
            read_attention(self.store, {'chat_id': follow['data']['chat_id'], 'workspace': 'lumos', 'ids': [follow['data']['notices'][0]['id']]})
        with self.store.db() as db:
            nodes = self.store.nodes(db)
        with self.assertRaises(lumos.Error):
            validate_notices(follow['data']['notices'], 'aipm', 'lingguang', nodes)
        original = copy.deepcopy(nodes['talk'])
        self.assertEqual(original['data']['follow_up'], '2026-11-22')
        self.assertEqual(list_conversations(self.store, 'lumos')['conversations'], [])
        with patch('lumos_intake.today', return_value='2026-11-21'), patch('lumos_ops.issue_groups', return_value=[]):
            synchronize_attention(self.store)
        self.assertFalse(any(i['active'] for c in self.chats() for i in c['data'].get('notices', []) if i['kind'] != 'reply'))
