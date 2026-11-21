import uuid
from datetime import datetime, timedelta
from unittest.mock import patch

from test_core import BaseStoreCase
from lumos_intake import POLICY, save_intake, claim_intake, fail_intake, intake_context
from lumos_agents import inspect_once, episodes
from lumos_ops import inspect_due, inspection_schedule, INSPECTION_TEXT


class OpsTest(BaseStoreCase):
    def setUp(self):
        super().setUp(); self.seed()
        self.source = {'type': 'user', 'ref': 'ISOLATED OPS TEST'}
        batch = self.store.begin({'reason': 'synthetic authorization', 'updates': [{'id': POLICY, 'kind': 'decision',
            'data': {'context': 'mapping', 'text': '模拟授权', 'reason': '测试', 'scope': '测试', 'source': self.source,
                     'autonomy_workspaces': ['lingguang'], 'ops_inspection_workspaces': ['lingguang']}}]}, True)
        self.store.commit(batch['batch'], True)

    def business(self):
        with self.store.db() as db:
            return {i: n for i, n in self.store.nodes(db).items() if n['kind'] != 'intake'}

    def test_weekly_checks_are_persistent_coalesced_and_never_change_business(self):
        before = self.business(); first = inspect_due(self.store)['intake']
        self.assertEqual(first['data']['status'], 'done')
        self.assertIsNone(inspect_due(self.store))
        future = (datetime.fromisoformat(first['data']['updated_at'])+timedelta(days=30)).isoformat()
        with patch('lumos_ops.now', return_value=future), patch('lumos_intake.now', return_value=future):
            second = inspect_due(self.store)['intake']
            self.assertNotEqual(first['id'], second['id'])
            self.assertIsNone(inspect_due(self.store))
        self.assertEqual(self.business(), before)
        self.assertEqual(len(episodes(self.store)['episodes']), 2)

    def test_user_input_has_priority_and_interrupted_inspection_resumes(self):
        pending = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': '先处理我的输入', 'source': self.source})['intake']
        self.assertIsNone(inspect_due(self.store))
        claim = claim_intake(self.store, pending['id']); fail_intake(self.store, pending['id'], claim['data']['claim'], '模拟故障')
        request = {'request_id': uuid.uuid4().hex, 'workspace': 'lingguang', 'source': {'type':'agent','ref':'weekly test','inspection':'weekly'}}
        job = save_intake(self.store, {**request, 'agent_role':'maintainer','execution':'conversation',
            'title':'仓库维护者 · 只读巡检','text':INSPECTION_TEXT})['intake']
        result = inspect_due(self.store)['intake']
        self.assertEqual(result['id'], job['id']); self.assertEqual(result['data']['status'], 'done')
        self.assertIsNone(inspect_due(self.store))

    def test_broken_fixed_source_is_reported_without_loading_body_or_repairing(self):
        before = self.business(); path = self.root/before['plan']['data']['version']; raw = path.read_bytes()
        path.write_bytes(b'corrupted synthetic fixture')
        result = inspect_due(self.store)['intake']
        self.assertEqual(result['data']['status'], 'done')
        finding = next(f for f in result['data']['findings'] if f.get('subject_id') == 'plan')
        self.assertEqual(finding['code'], 'source')
        self.assertEqual(path.read_bytes(), b'corrupted synthetic fixture')
        self.assertEqual(self.business(), before)
        context = intake_context(self.store, result['id']); self.assertEqual(context['records'], [])
        path.write_bytes(raw)
        inspect_once(self.store, {'request_id': uuid.uuid4().hex, 'source': self.source})
        self.assertEqual(next(i for i in episodes(self.store)['issues'] if i.get('subject_id') == 'plan')['status'], 'rechecked')

    def test_repeated_failure_is_one_issue_with_count_and_original_attempts(self):
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text':'模拟任务', 'source':self.source})['intake']
        for _ in range(2):
            claimed = claim_intake(self.store, job['id']); fail_intake(self.store, job['id'], claimed['data']['claim'], '权限拒绝')
            with self.store.db() as db:
                job = self.store.nodes(db)[job['id']]
            if job['data']['ops_report']['count'] == 1:
                save_intake(self.store, {'request_id':uuid.uuid4().hex,'id':job['id'],'expected_revision':job['data']['revision']})
        issues=episodes(self.store)['issues']; self.assertEqual(len(issues),1); self.assertEqual(issues[0]['count'],2)
        self.assertEqual(len(issues[0]['occurrences']),2)

    def test_weekly_checks_require_explicit_policy(self):
        nodes=self.business(); nodes[POLICY]['data'].pop('ops_inspection_workspaces')
        self.assertFalse(inspection_schedule(nodes, 'lingguang')['enabled'])
        self.assertFalse(inspection_schedule(nodes, 'lumos')['enabled'])
