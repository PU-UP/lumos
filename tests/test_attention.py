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

    def test_deleted_threads_do_not_return_but_new_followup_can_start_another_thread(self):
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
            'id': 'talk', 'changes': {'follow_up': '2026-11-21'}, 'source': self.source})
        with patch('lumos_intake.today', return_value='2026-11-22'):
            synchronize_attention(self.store)
            old = self.chats()[0]; d = old['data']
            save_conversation(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': d['chat_id'], 'agent_role': d['agent_role'],
                'workspace': d['workspace'], 'expected_revision': d['revision'], 'operation': 'delete', 'confirmed': True})
            self.assertEqual(synchronize_attention(self.store), 0)
            save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
                'id': 'talk', 'changes': {'follow_up': '2026-11-22'}, 'source': self.source})
            synchronize_attention(self.store)
        chats = self.chats()
        self.assertEqual(len([c for c in chats if not c['data'].get('deleted')]), 1)
        self.assertTrue(next(c for c in chats if c['id'] == old['id'])['data']['deleted'])
        self.assertNotEqual(next(c for c in chats if not c['data'].get('deleted'))['id'], old['id'])


    def seed_topic(self):
        with self.store.db() as db:
            task = copy.deepcopy(self.store.nodes(db)['talk'])
        task['id'] = 'calibration'; task['data']['text'] = '模拟标定'
        line = {'id': 'topic-line', 'kind': 'mainline', 'data': {'title': '模拟联调主线', 'context': 'mapping',
            'goal': '核对条件', 'summary': '尚待验证', 'phase': '准备', 'as_of': '2026-11-20',
            'task_ids': ['talk', 'calibration'], 'source_ids': ['assumption'], 'source': self.source}}
        batch = self.store.begin({'reason': 'isolated topic fixture', 'updates': [task, line]}, True)
        self.store.commit(batch['batch'], True)

    def test_mainline_followups_share_one_topic_and_only_unanswered_tasks_return(self):
        self.seed_topic()
        for ident in ('talk', 'calibration'):
            save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
                'id': ident, 'changes': {'follow_up': '2026-11-23'}, 'source': self.source})
        with patch('lumos_intake.today', return_value='2026-11-23'):
            synchronize_attention(self.store)
            chats = self.chats(); self.assertEqual(len(chats), 1)
            item = chats[0]['data']['notices'][0]
            self.assertEqual(chats[0]['data']['title'], '模拟联调主线')
            self.assertEqual(set(item['related_ids']), {'talk', 'calibration', 'topic-line'})
            self.assertEqual(len(item['followup_keys']), 2)
            request = self.job(chat_id=chats[0]['data']['chat_id'], question_key=item['key'], question_keys=item['followup_keys'],
                               related_ids=item['related_ids'], text='暂无变化')
            apply_intake(self.store, request)
            synchronize_attention(self.store)
            self.assertFalse(any(n['active'] for n in self.chats()[0]['data']['notices'] if n['kind'] == 'followup'))
            save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
                'id': 'calibration', 'changes': {'follow_up': '2026-11-24'}, 'source': self.source})
        with patch('lumos_intake.today', return_value='2026-11-24'):
            synchronize_attention(self.store)
        self.assertEqual(len(self.chats()), 1)
        active = [n for n in self.chats()[0]['data']['notices'] if n['kind'] == 'followup' and n['active']]
        self.assertEqual(len(active), 1); self.assertNotIn('talk', active[0]['related_ids'])
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_chat_answer_updates_task_mainline_question_and_state_atomically(self):
        self.seed_topic()
        first = self.job(related_ids=['talk', 'topic-line'])
        first['plan']['questions'] = ['同步结果是否确认？']; apply_intake(self.store, first)
        chat = self.chats()[0]['data']; self.assertTrue(chat['awaiting_reply'])
        self.assertEqual(chat['topic_state'], 'waiting')
        text = '同步结果已确认，可继续准备联调。'
        second = self.job(chat_id=chat['chat_id'], chat_parent=first['id'], related_ids=[],
                          question_key='question:'+first['id']+':0', text=text)
        context = intake_context(self.store, second['id'])
        self.assertEqual(set(context['intake']['data']['related_ids']), {'talk', 'topic-line'})
        self.assertEqual(context['conversation_questions'][0]['intake_id'], first['id'])
        def update(ident, kind, changes):
            return {'id': ident, 'kind': kind, 'changes': changes, 'mode': 'reported', 'reason': '模拟明确进展', 'excerpt': text}
        second['plan']['updates'] = [update('talk', 'action', {'progress': '同步结果已确认', 'next_step': '准备联调'}),
                                    update('topic-line', 'mainline', {'summary': '同步已核对，继续准备联调', 'next_step': '准备联调'})]
        second['plan']['resolutions'] = [{'intake_id': first['id'], 'index': 0, 'answer': '已确认', 'excerpt': text,
                                        'state': 'resolved', 'remaining': '', 'review_on': '', 'waiting_for': ''}]
        bad = copy.deepcopy(second); bad['plan']['updates'][1]['excerpt'] = '未出现的原话'
        before = self.store.status()['seq']
        with self.assertRaises(lumos.Error): apply_intake(self.store, bad)
        self.assertEqual(self.store.status()['seq'], before)
        apply_intake(self.store, second)
        with self.store.db() as db: nodes = self.store.nodes(db)
        self.assertEqual(nodes['talk']['data']['progress'], '同步结果已确认')
        self.assertEqual(nodes['talk']['data']['status'], 'todo')
        self.assertEqual(nodes['topic-line']['data']['summary'], '同步已核对，继续准备联调')
        self.assertEqual(nodes[first['id']]['data']['resolutions'][0]['source_intake'], second['id'])
        self.assertEqual(nodes['chat-'+chat['chat_id']]['data']['topic_state'], 'settled')
        self.assertFalse(nodes['chat-'+chat['chat_id']]['data']['awaiting_reply'])
        self.assertTrue(apply_intake(self.store, second)['replayed'])

    def test_unanswered_questions_prevent_false_settlement_and_topic_catalog_keeps_roles_separate(self):
        first = self.job(); first['plan']['questions'] = ['同步结果？']; apply_intake(self.store, first)
        chat = self.chats()[0]['data']
        other = self.job('maintainer'); apply_intake(self.store, other)
        second = self.job(chat_id=chat['chat_id'], chat_parent=first['id'])
        self.assertFalse(intake_context(self.store, second['id'])['topic_conversations'])
        apply_intake(self.store, second)
        latest = next(c['data'] for c in self.chats() if c['data']['chat_id'] == chat['chat_id'])
        self.assertTrue(latest['awaiting_reply']); self.assertEqual(latest['topic_state'], 'waiting')


    def test_topic_matching_requires_exact_membership_not_context_or_similar_titles(self):
        from lumos_attention import conversation_topic
        self.seed_topic()
        with self.store.db() as db: nodes = self.store.nodes(db)
        self.assertEqual(conversation_topic(nodes, ['talk']), 'topic-line')
        self.assertEqual(conversation_topic(nodes, ['calibration']), 'topic-line')
        self.assertEqual(conversation_topic(nodes, ['mapping']), '')
        duplicate = copy.deepcopy(nodes['topic-line']); duplicate['id'] = 'other-line'
        nodes[duplicate['id']] = duplicate
        self.assertEqual(conversation_topic(nodes, ['talk']), 'talk')
        self.assertEqual(conversation_topic(nodes, ['talk', 'calibration']), '')

    def test_no_change_answer_schedules_followup_without_inventing_progress_or_completion(self):
        from datetime import date, timedelta
        from lumos_intake import today
        with self.store.db() as db: nodes = self.store.nodes(db)
        policy = nodes[POLICY]; policy['data']['task_management_workspaces'] = ['lingguang']
        batch = self.store.begin({'reason': 'isolated management grant', 'updates': [policy]}, True); self.store.commit(batch['batch'], True)
        first = self.job(); first['plan']['questions'] = ['同步结果？']; apply_intake(self.store, first)
        chat = self.chats()[0]['data']; future = (date.fromisoformat(today())+timedelta(days=3)).isoformat()
        second = self.job(chat_id=chat['chat_id'], chat_parent=first['id'], text='暂无变化', question_key='question:'+first['id']+':0')
        second['plan']['resolutions'] = [{'intake_id': first['id'], 'index': 0, 'answer': '暂无变化', 'excerpt': '暂无变化',
            'state': 'waiting', 'remaining': '同步结果？', 'review_on': future, 'waiting_for': '同步验证结果'}]
        with self.store.db() as db: before = self.store.nodes(db)['talk']['data']
        apply_intake(self.store, second)
        with self.store.db() as db: after = self.store.nodes(db)['talk']['data']
        for field in ('status', 'progress', 'due', 'planned_due', 'completed_on'):
            self.assertEqual(after.get(field), before.get(field))
        self.assertEqual(after['follow_up'], future)
        self.assertEqual(self.chats()[0]['data']['topic_state'], 'settled')
        synchronize_attention(self.store)
        self.assertFalse(any(n['active'] for n in self.chats()[0]['data']['notices'] if n['kind'] == 'question'))

    def test_merge_reminders_preserves_sources_questions_read_states_and_future_route(self):
        from lumos_attention import notice
        from lumos_tasks import commit_tasks
        self.seed_topic()
        question = self.job('aipm'); question['plan']['questions'] = ['同步结果？']
        from lumos_worker import collaborate
        from lumos_agents import prepare_execution
        context = intake_context(self.store, question['id']); plan = question['plan']
        question['plan'] = collaborate(self.store, context['intake'], context, lambda *args: copy.deepcopy(plan))
        prepare_execution(self.store, question['id'], question['claim'], question['plan']); apply_intake(self.store, question)
        synchronize_attention(self.store)
        target = next(c for c in self.chats() if c['data']['agent_role'] == 'lumos')
        source = save_conversation(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex,
            'workspace': 'lingguang', 'agent_role': 'lumos', 'title': '旧标定提醒', 'source_ids': ['calibration']})['conversation']
        source['data']['notices'] = [notice('old-followup', 'followup', '旧问题原文', 'calibration', ['calibration'])]
        source['data']['notices'][0]['seen_at'] = '2026-11-20T00:00:00Z'; source['data']['revision'] += 1
        with self.store.db() as db: nodes = self.store.nodes(db)
        commit_tasks(self.store, nodes, {'reason': 'isolated old reminder', 'updates': [source]}, source['id'])
        with self.store.db() as db: before = self.store.nodes(db)
        request = {'request_id': uuid.uuid4().hex, 'operation': 'merge', 'chat_id': target['data']['chat_id'],
            'agent_role': 'lumos', 'workspace': 'lingguang', 'expected_revision': target['data']['revision'],
            'merge_from': {source['data']['chat_id']: source['data']['revision']}, 'reason': '同一模拟主线', 'title': '模拟主线'}
        merged = save_conversation(self.store, request)['conversation']
        self.assertTrue(save_conversation(self.store, request)['replayed'])
        with self.store.db() as db: after = self.store.nodes(db)
        self.assertEqual(after[source['id']]['data']['notices'], before[source['id']]['data']['notices'])
        for ident, node in before.items():
            if node['kind'] != 'conversation': self.assertEqual(after[ident], node)
        self.assertTrue(all(item in merged['data']['notices'] for c in [target, source] for item in c['data']['notices']))
        self.assertEqual(after[source['id']]['data']['merged_into'], target['data']['chat_id'])
        self.assertEqual(merged['data']['topic_id'], 'topic-line')
        with self.assertRaises(lumos.Error):
            save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': source['data']['chat_id'], 'text': '旧入口', 'source': self.source})
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
            'id': 'calibration', 'changes': {'follow_up': '2026-11-23'}, 'source': self.source})
        with patch('lumos_intake.today', return_value='2026-11-23'):
            synchronize_attention(self.store); seq = self.store.status()['seq']; synchronize_attention(self.store)
        self.assertEqual(self.store.status()['seq'], seq)
        live = [c for c in self.chats() if c['data']['agent_role'] == 'lumos' and not c['data'].get('merged_into')]
        self.assertEqual(len(live), 1)
        self.assertTrue(any(n['kind'] == 'followup' and n['active'] for n in live[0]['data']['notices']))
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_merge_rejects_stale_cross_role_and_actual_message_history_without_partial_write(self):
        target = self.job(); apply_intake(self.store, target)
        source = self.job(); apply_intake(self.store, source)
        chats = self.chats(); a, b = chats
        request = {'request_id': uuid.uuid4().hex, 'operation': 'merge', 'chat_id': a['data']['chat_id'],
            'agent_role': 'lumos', 'workspace': 'lingguang', 'expected_revision': a['data']['revision'],
            'merge_from': {b['data']['chat_id']: b['data']['revision']}, 'reason': '核对'}
        seq = self.store.status()['seq']
        for override in ({}, {'expected_revision': 0}, {'agent_role': 'maintainer'}):
            with self.assertRaises(lumos.Error): save_conversation(self.store, {**request, **override})
            self.assertEqual(self.store.status()['seq'], seq)

    def test_ops_routing_uses_exact_incident_work_not_shared_error_wording(self):
        from lumos_attention import notice_topic, notice
        nodes = {'line': {'kind': 'mainline', 'data': {}}, 'incident': {'kind': 'intake', 'data': {'related_ids': ['line']}}}
        self.assertEqual(notice_topic(nodes, nodes, notice('ops:x', 'ops', '相同报错', 'incident', [])), 'line')
        self.assertEqual(notice_topic(nodes, nodes, notice('ops:y', 'ops', '相同报错', 'other', [])), '')
