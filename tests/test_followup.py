import unittest

from lumos_followup import followup_questions, synchronize_followups


class FollowupTest(unittest.TestCase):
    def test_waiting_fallback_uses_shanghai_answer_date(self):
        nodes = {'q': {'id': 'q', 'kind': 'intake', 'data': {
            'workspace': 'lingguang', 'status': 'needs_review', 'questions': ['结果？'],
            'resolutions': [{'index': 0, 'state': 'waiting', 'remaining': '结果？',
                             'review_on': '', 'waiting_for': '实测后'}]}}}
        answer = nodes['q']['data']['resolutions'][0]
        for at, expected in [('2026-11-19T15:59:59+00:00', '2026-11-26'),
                             ('2026-11-19T16:00:00+00:00', '2026-11-27'),
                             ('2026-11-20T00:00:00+08:00', '2026-11-27'),
                             ('2026-12-31T16:30:00+00:00', '2027-01-08')]:
            with self.subTest(at=at):
                answer['at'] = at
                self.assertEqual(followup_questions(nodes, 'lingguang', {})[0]['follow_up_on'], expected)
                self.assertEqual(answer['at'], at)

    def test_early_morning_answer_ignores_same_day_followup(self):
        nodes = {
            'c': {'id': 'c', 'kind': 'context', 'data': {'workspace': 'lingguang'}},
            'a': {'id': 'a', 'kind': 'action', 'data': {'context': 'c', 'status': 'doing',
                'follow_up': '2026-11-20', 'planned_due': '2026-11-21'}},
            'q': {'id': 'q', 'kind': 'intake', 'data': {'workspace': 'lingguang', 'status': 'needs_review',
                'questions': ['T-001的结果？'], 'resolutions': [{'index': 0, 'state': 'waiting',
                    'remaining': 'T-001的结果？', 'at': '2026-11-19T16:30:00+00:00',
                    'review_on': '', 'waiting_for': '实测后'}]}},
        }
        self.assertEqual(followup_questions(nodes, 'lingguang', {'a': 'T-001'})[0]['follow_up_on'], '2026-11-21')

    def test_exact_current_scope_delivery_cap_and_no_event_wait_forever(self):
        from lumos_intake import POLICY
        nodes = {
            'c': {'id': 'c', 'kind': 'context', 'data': {'workspace': 'lingguang'}},
            POLICY: {'kind': 'decision', 'data': {'source': {'type': 'user'},
                'autonomy_workspaces': ['lingguang'], 'task_management_workspaces': ['lingguang']}},
            'q': {'id': 'q', 'kind': 'intake', 'data': {'workspace': 'lingguang', 'status': 'needs_review',
                'questions': ['T-001/T-002的结果？'], 'resolutions': [{'index': 0, 'state': 'waiting',
                    'remaining': 'T-001的结果？', 'at': '2026-11-19T12:00:00+08:00',
                    'review_on': '', 'waiting_for': '实测后'}]}},
        }
        for i in ('a', 'b'):
            nodes[i] = {'id': i, 'kind': 'action', 'data': {'context': 'c', 'status': 'doing',
                'follow_up': '2026-11-19', 'due': '2026-11-18', 'planned_due': '2026-11-20',
                'task_review': {'question': {'intake_id': 'q', 'index': 0}}}}
        numbers = {'a': 'T-001', 'b': 'T-002'}
        q = followup_questions(nodes, 'lingguang', numbers)[0]
        self.assertEqual(q['task_ids'], ['a'])
        self.assertEqual(q['follow_up_on'], '2026-11-20')
        updates = synchronize_followups(nodes, numbers)
        self.assertEqual([n['id'] for n in updates], ['a'])
        self.assertEqual(updates[0]['data']['due'], '2026-11-18')
        nodes['a']['data']['planned_due'] = ''
        self.assertEqual(followup_questions(nodes, 'lingguang', numbers)[0]['follow_up_on'], '2026-11-26')
        nodes['a']['data']['status'] = 'done'
        self.assertEqual(synchronize_followups(nodes, numbers), [])
