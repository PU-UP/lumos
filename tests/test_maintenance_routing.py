import json
import uuid
from pathlib import Path

from test_core import BaseStoreCase, fixture
from lumos_intake import POLICY, save_intake, claim_intake, intake_context, apply_intake
from lumos_tasks import list_tasks
from lumos_attention import synchronize_attention
from lumos_conversations import list_conversations
from lumos_agents import episodes


class MaintenanceRoutingTest(BaseStoreCase):
    def setUp(self):
        super().setUp()
        data = json.loads(json.dumps(fixture()).replace('"mapping"', '"lumos-maintenance"'))
        data['updates'].append({'id': POLICY, 'kind': 'decision', 'data': {
            'context': 'lumos-maintenance', 'text': '模拟授权', 'reason': 'test', 'scope': 'test',
            'autonomy_workspaces': ['lingguang'], 'task_management_workspaces': ['lingguang'],
            'source': {'type': 'user', 'ref': 'synthetic'}}})
        data['updates'].append({'id': 'business', 'kind': 'action', 'data': {
            'context': 'prep', 'text': 'Ops backup words in a real project task', 'owner': 'Ops',
            'condition': 'test', 'status': 'todo', 'source': {'type': 'user', 'ref': 'synthetic'}}})
        # Unified workspace; the legacy context identity supplies the exact maintenance boundary.
        for n in data['updates']:
            if n['kind'] == 'context': n['data']['workspace'] = 'lingguang'
        batch = self.store.begin(data, True)
        for path in batch['candidates'].values(): Path(path).write_text('模拟正文', encoding='utf-8')
        self.store.commit(batch['batch'], True)

    def ask(self, text):
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex,
            'execution': 'automatic', 'text': text, 'source': {'type': 'user', 'ref': 'synthetic'}})['intake']
        claimed = claim_intake(self.store, job['id']); context = intake_context(self.store, job['id'])
        apply_intake(self.store, {'id': job['id'], 'claim': claimed['data']['claim'], 'basis': context['basis'],
            'plan': {'summary': '模拟待确认', 'reply': text, 'questions': [text], 'updates': [], 'resolutions': []}})
        return job

    def test_exact_maintenance_question_routes_to_ops_without_changing_work_or_closing_question(self):
        state = list_tasks(self.store); number = next(t['short_id'] for t in state['tasks'] if t['id'] == 'talk')
        job = self.ask(number+' 独立备份存放在哪里？')
        before = list_tasks(self.store); synchronize_attention(self.store); after = list_tasks(self.store)
        self.assertEqual(before['tasks'], after['tasks']); self.assertEqual(before['open_questions'], after['open_questions'])
        q = next(q for q in after['open_questions'] if q['intake_id'] == job['id'])
        self.assertEqual(q['work_role'], 'maintainer')
        chats = list_conversations(self.store)['conversations']
        routed = [n for n in chats if any(i['active'] and i['key'].startswith('maintenance:') for i in n['data'].get('notices', []))]
        self.assertEqual(len(routed), 1); self.assertEqual(routed[0]['data']['agent_role'], 'maintainer')
        self.assertEqual(synchronize_attention(self.store), 0)
        work = episodes(self.store, 'lingguang')['maintenance']
        self.assertEqual([n['id'] for n in work['tasks']], ['talk']); self.assertEqual(work['questions'][0]['question'], q['question'])

    def test_mixed_question_and_business_named_ops_stay_with_lumos(self):
        state = list_tasks(self.store); nums = {t['id']: t['short_id'] for t in state['tasks']}
        self.ask(nums['talk']+' 和 '+nums['business']+' 如何协调？')
        q = list_tasks(self.store)['open_questions'][0]
        self.assertEqual(q['work_role'], 'lumos')
        self.assertEqual(next(t for t in state['tasks'] if t['id']=='business')['work_role'], 'lumos')

    def test_ops_reads_maintenance_only_and_project_review_excludes_it(self):
        ops = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'agent_role': 'maintainer',
            'text': '模拟维护核对', 'execution': 'conversation', 'source': {'type': 'user', 'ref': 'synthetic'}})['intake']
        context = intake_context(self.store, ops['id'])
        self.assertEqual(context['records'], [])
        self.assertEqual([n['id'] for n in context['maintenance']['tasks']], ['talk'])
        review = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'task_review': True,
            'text': '模拟项目复核', 'execution': 'conversation', 'source': {'type': 'user', 'ref': 'synthetic'}})['intake']
        records = intake_context(self.store, review['id'])['records']
        self.assertEqual([n['id'] for n in records if n['kind']=='action'], ['business'])
