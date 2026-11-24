import json
import os
import tempfile
import unittest
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from lumos_worker import codex_models, plan_with_codex, SCHEMA


class WorkerTest(unittest.TestCase):
    def test_executor_reports_only_observed_activity_and_keeps_json_for_validation(self):
        import sys
        from lumos_worker import codex_activity, execute_step
        events = [{'type': 'error', 'message': 'Reconnecting... 2/5 private diagnostics'},
                  {'type': 'item.completed', 'item': {'text': 'private answer'}}]
        script = ('import json,time; print(' + repr(json.dumps(events[0])) +
                  ',flush=True); time.sleep(0.8); print(' + repr(json.dumps(events[1])) + ')')
        reports = []
        with tempfile.TemporaryDirectory() as folder:
            result = execute_step([sys.executable, '-c', script], '', Path(folder), lambda message, kind: reports.append(message))
        self.assertEqual([json.loads(line) for line in result.stdout.splitlines()], events)
        self.assertIn('Codex 正在重新连接（2/5）', reports)
        self.assertIn('已收到 Codex 步骤结果', reports)
        self.assertNotIn('private', str(reports))
        self.assertFalse(codex_activity({'type': 'error', 'message': 'unknown error'}))

    def test_fatal_executor_errors_are_classified_without_replaying_or_leaking_messages(self):
        from lumos import Error
        msg = json.dumps({'type': 'turn.failed', 'error': {'message': 'unsupported reasoning effort',
                                                           'code': 'invalid_value'}})
        failed = SimpleNamespace(returncode=1, stdout=msg, stderr='WARN unrelated private diagnostics')
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), \
             patch('lumos_worker.execute_step', return_value=failed) as execute:
            with self.assertRaisesRegex(Error, '推理强度|配置值') as caught:
                plan_with_codex({'intake': {'data': {}}}, Path(folder))
            self.assertNotIn('private', str(caught.exception))
            execute.assert_called_once()

    def test_temporary_executor_failure_retries_once_with_same_command_and_remaining_budget(self):
        from lumos import Error
        failed = SimpleNamespace(returncode=1, stdout='', stderr='Error: HTTP 503 service temporarily unavailable')
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), \
             patch('lumos_worker.execute_step', return_value=failed) as execute:
            with self.assertRaisesRegex(Error, '已自动重试一次'):
                plan_with_codex({'intake': {'data': {}}}, Path(folder))
            self.assertEqual(execute.call_count, 2)
            first, second = execute.call_args_list
            self.assertEqual(first.args, second.args)
            self.assertLessEqual(second.kwargs['timeout'], first.kwargs['timeout'])

    def test_worker_survives_database_and_unexpected_errors_and_reports_dead_thread(self):
        from lumos_worker import Worker
        for failure in (sqlite3.OperationalError('database is locked'), ValueError('bad record')):
            worker = Worker(None); states = []
            def wait(_):
                states.append(worker.health())
                if len(states) == 2:
                    worker.stop.set()
            with patch('lumos_worker.executable', return_value='codex'), \
                 patch('lumos_worker.run_once', side_effect=[failure, {'status': 'idle'}]) as run, \
                 patch('lumos_attention.synchronize_attention'), patch.object(worker.stop, 'wait', side_effect=wait), \
                 self.assertLogs('lumos_worker', level='ERROR'):
                worker.thread.start(); worker.thread.join(2)
                self.assertFalse(worker.thread.is_alive())
                self.assertEqual(run.call_count, 2)
            self.assertEqual([s['state'] for s in states], ['waiting', 'available'])
            self.assertIn(type(failure).__name__, states[0]['error'])
            self.assertEqual(states[1]['error'], '')
            self.assertTrue(states[0]['last_check'])
            worker._state = 'available'
            self.assertEqual(worker.state, 'stopped')

    def test_lumos_decision_schema_can_decide_tasks_but_cannot_change_evidence(self):
        def run(command, **kwargs):
            schema = json.loads(Path(command[command.index('--output-schema')+1]).read_text())
            kinds = {k for item in schema['properties']['updates']['items']['anyOf'] for k in item['properties']['kind']['enum']}
            self.assertEqual(kinds, {'action', 'mainline', 'person'})
            self.assertNotIn('maxItems', schema['properties']['questions'])
            self.assertIn('decide 阶段', kwargs['input'])
            Path(command[command.index('--output-last-message')+1]).write_text(json.dumps({
                'summary': '决定', 'questions': [], 'updates': [], 'resolutions': [], 'delegate_to': [], 'search_query': ''}), encoding='utf-8')
            return SimpleNamespace(returncode=0, stdout=json.dumps({'type': 'turn.completed'}))
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            plan_with_codex({'intake': {'data': {}}, 'agent': {'role': 'lumos', 'phase': 'decide'}}, Path(folder))

    def test_note_format_uses_astra_and_cannot_request_business_updates(self):
        def run(command, **kwargs):
            self.assertEqual(command[2:4], ['--model', 'gpt-6.2-astra'])
            schema = json.loads(Path(command[command.index('--output-schema')+1]).read_text())
            self.assertEqual(schema['required'], ['summary', 'note_format'])
            self.assertNotIn('updates', schema['properties'])
            self.assertIn('不更新知识库', kwargs['input'])
            self.assertIn('web_search="live"', command)
            self.assertIn('最下方', kwargs['input'])
            Path(command[command.index('--output-last-message')+1]).write_text(json.dumps({
                'summary': '润色', 'note_format': {'title': '记录', 'body': '# 记录\n原文', 'related_ids': []}}), encoding='utf-8')
            return SimpleNamespace(returncode=0, stdout='\n'.join(map(json.dumps, [{'item': {'type': 'web_search'}}, {'type': 'turn.completed'}])))
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            plan = plan_with_codex({'intake': {'data': {'note_mode': 'format', 'model': 'gpt-6.2-astra'}}}, Path(folder))
        self.assertEqual(plan['updates'], [])
        self.assertEqual(plan['questions'], [])

    def test_task_review_uses_complete_coverage_schema_and_management_prompt(self):
        def run(command, **kwargs):
            schema = json.loads(Path(command[command.index('--output-schema')+1]).read_text())
            self.assertIn('task_reviews', schema['required'])
            self.assertIn('逐项核对', kwargs['input'])
            Path(command[command.index('--output-last-message')+1]).write_text(json.dumps({
                'summary': 'review', 'questions': [], 'updates': [], 'resolutions': [], 'task_reviews': []}), encoding='utf-8')
            return SimpleNamespace(returncode=0, stdout=json.dumps({'type': 'turn.completed'}))
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            self.assertEqual(plan_with_codex({'intake': {'data': {'task_review': True}}}, Path(folder))['task_reviews'], [])
        self.assertNotIn('task_reviews', SCHEMA['required'])

    def test_model_catalog_filters_internal_metadata_and_handles_missing_cache(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'CODEX_HOME': folder}), patch('lumos_worker.executable', return_value='codex'):
            self.assertEqual(codex_models()['models'], [])
            Path(folder, 'models_cache.json').write_text(json.dumps({'models': [
                {'slug': 'visible', 'display_name': 'Visible', 'visibility': 'list', 'instructions': 'private'},
                {'slug': 'gpt-5.6-sol', 'visibility': 'list'},
                {'slug': 'gpt-6.2-sol', 'visibility': 'list', 'supported_reasoning_levels': [{'effort': 'medium'}, {'effort': 'high'}]},
                {'slug': 'hidden', 'visibility': 'hide'}, {'slug': '--bad', 'visibility': 'list'}, None]}), encoding='utf-8')
            self.assertEqual(codex_models()['models'], [{'id': 'visible', 'name': 'Visible'},
                             {'id': 'gpt-6.2-sol', 'name': 'gpt-6.2-sol', 'efforts': ['medium', 'high']}])

    def test_chat_model_argument_schema_and_history_use_existing_bounded_runner(self):
        context = {'intake': {'data': {'chat_id': 'a'*32, 'model': 'test-model', 'reasoning_effort': 'high'}},
                   'chat_history': [{'text': 'prior input', 'reply': 'prior answer'}]}
        def run(command, **kwargs):
            self.assertEqual(command[command.index('--model')+1], 'test-model')
            self.assertIn('model_reasoning_effort="high"', command)
            self.assertIn('--ephemeral', command)
            self.assertEqual('features.respect_system_proxy=true' in command, os.name == 'nt')
            self.assertIn('features.shell_tool=false', command)
            self.assertIn('web_search="disabled"', command)
            self.assertIn('prior answer', kwargs['input'])
            schema = json.loads(Path(command[command.index('--output-schema')+1]).read_text())
            self.assertIn('reply', schema['required'])
            resolution = schema['properties']['resolutions']['items']
            self.assertEqual(set(resolution['required']), set(resolution['properties']))
            self.assertEqual(resolution['properties']['state']['enum'], ['resolved', 'pending', 'waiting'])
            self.assertIn('remaining', resolution['properties'])
            self.assertIn('waiting_for', resolution['properties'])
            Path(command[command.index('--output-last-message')+1]).write_text(json.dumps({
                'summary': 'discussion', 'reply': 'answer', 'questions': [], 'updates': [], 'resolutions': []}), encoding='utf-8')
            return SimpleNamespace(returncode=0, stdout=json.dumps({'type': 'turn.completed'}))
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            self.assertEqual(plan_with_codex(context, Path(folder))['reply'], 'answer')
        self.assertNotIn('reply', SCHEMA['required'])

    def test_cli_plan_progress_reaches_candidate_but_tool_calls_never_do(self):
        from lumos import Error
        events = [{'type': 'thread.started'}, {'type': 'turn.started'}]
        for phase in ('item.started', 'item.updated', 'item.completed'):
            events.append({'type': phase, 'item': {'id': 'p1', 'type': 'todo_list',
                                                   'items': [{'text': 'review', 'completed': phase == 'item.completed'}]}})
        events.extend([{'type': 'item.completed', 'item': {'type': 'error', 'message': 'non-fatal'}},
                       {'type': 'turn.completed'}])
        def run(command, **kwargs):
            Path(command[command.index('--output-last-message')+1]).write_text(json.dumps({
                'summary': 'ok', 'reply': 'answer', 'questions': [], 'updates': [], 'resolutions': []}))
            return SimpleNamespace(returncode=0, stdout='\n'.join(map(json.dumps, events)))
        ctx = {'agent': {'role': 'lumos', 'phase': 'coordinate'}, 'intake': {'data': {'chat_id': 'test'}}}
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), \
             patch('lumos_worker.subprocess.run', side_effect=run):
            self.assertEqual(plan_with_codex(ctx, Path(folder))['reply'], 'answer')
            for kind in ('mcp_tool_call', 'command_execution', 'file_change', 'collab_tool_call', 'web_search', 'future_item'):
                item = {'type': kind, 'server': 'example', 'tool': 'lookup', 'arguments': 'private-input'}
                events.insert(-1, {'type': 'item.started', 'item': item})
                with self.assertRaisesRegex(Error, kind) as caught:
                    plan_with_codex(ctx, Path(folder))
                self.assertNotIn('private-input', str(caught.exception))
                events.pop(-2)
            events[-1] = {'type': 'turn.failed'}
            with self.assertRaisesRegex(Error, '失败'):
                plan_with_codex(ctx, Path(folder))
            events.pop()
            with self.assertRaisesRegex(Error, '未确认'):
                plan_with_codex(ctx, Path(folder))
            events.clear()
            with self.assertRaisesRegex(Error, '未确认'):
                plan_with_codex(ctx, Path(folder))

    def test_task_output_schema_excludes_review_metadata_and_preserves_clear_values(self):
        from lumos_tasks import FIELDS
        def run(command, **kwargs):
            schema = json.loads(Path(command[command.index('--output-schema')+1]).read_text())
            action = schema['properties']['updates']['items']['anyOf'][0]
            fields = action['properties']['changes']
            self.assertEqual(set(fields['properties']), FIELDS)
            self.assertFalse(fields['additionalProperties'])
            self.assertNotIn('task_review', fields['properties'])
            self.assertNotIn('task_reviews', schema['properties'])
            changes = {k: None for k in FIELDS}
            changes.update(progress='New report', follow_up='')
            Path(command[command.index('--output-last-message')+1]).write_text(json.dumps({
                'summary': 'updated', 'questions': [], 'resolutions': [], 'updates': [
                    {'id': 'task', 'kind': 'action', 'changes': changes, 'reason': 'report', 'excerpt': 'report', 'mode': 'reported'}]}), encoding='utf-8')
            return SimpleNamespace(returncode=0, stdout=json.dumps({'type': 'turn.completed'}))
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            result = plan_with_codex({'intake': {'data': {}}}, Path(folder))
        self.assertEqual(result['updates'][0]['changes'], {'progress': 'New report', 'follow_up': ''})
