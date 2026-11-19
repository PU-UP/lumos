import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from lumos_worker import codex_models, plan_with_codex, SCHEMA


class WorkerTest(unittest.TestCase):
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
            return SimpleNamespace(returncode=0, stdout=json.dumps({'item': {'type': 'web_search'}}))
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
            return SimpleNamespace(returncode=0, stdout='')
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            self.assertEqual(plan_with_codex({'intake': {'data': {'task_review': True}}}, Path(folder))['task_reviews'], [])
        self.assertNotIn('task_reviews', SCHEMA['required'])

    def test_model_catalog_filters_internal_metadata_and_handles_missing_cache(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'CODEX_HOME': folder}), patch('lumos_worker.executable', return_value='codex'):
            self.assertEqual(codex_models()['models'], [])
            Path(folder, 'models_cache.json').write_text(json.dumps({'models': [
                {'slug': 'visible', 'display_name': 'Visible', 'visibility': 'list', 'instructions': 'private'},
                {'slug': 'hidden', 'visibility': 'hide'}, {'slug': '--bad', 'visibility': 'list'}, None]}), encoding='utf-8')
            self.assertEqual(codex_models()['models'], [{'id': 'visible', 'name': 'Visible'}])

    def test_chat_model_argument_schema_and_history_use_existing_bounded_runner(self):
        context = {'intake': {'data': {'chat_id': 'a'*32, 'model': 'test-model'}},
                   'chat_history': [{'text': 'prior input', 'reply': 'prior answer'}]}
        def run(command, **kwargs):
            self.assertEqual(command[2:4], ['--model', 'test-model'])
            self.assertIn('--ephemeral', command)
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
            return SimpleNamespace(returncode=0, stdout='')
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            self.assertEqual(plan_with_codex(context, Path(folder))['reply'], 'answer')
        self.assertNotIn('reply', SCHEMA['required'])

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
            return SimpleNamespace(returncode=0, stdout='')
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            result = plan_with_codex({'intake': {'data': {}}}, Path(folder))
        self.assertEqual(result['updates'][0]['changes'], {'progress': 'New report', 'follow_up': ''})
