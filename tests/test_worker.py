import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from lumos_worker import codex_models, plan_with_codex, SCHEMA


class WorkerTest(unittest.TestCase):
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
            self.assertIn('prior answer', kwargs['input'])
            schema = json.loads(Path(command[command.index('--output-schema')+1]).read_text())
            self.assertIn('reply', schema['required'])
            Path(command[command.index('--output-last-message')+1]).write_text(json.dumps({
                'summary': 'discussion', 'reply': 'answer', 'questions': [], 'updates': [], 'resolutions': []}), encoding='utf-8')
            return SimpleNamespace(returncode=0, stdout='')
        with tempfile.TemporaryDirectory() as folder, patch('lumos_worker.executable', return_value='codex'), patch('lumos_worker.subprocess.run', side_effect=run):
            self.assertEqual(plan_with_codex(context, Path(folder))['reply'], 'answer')
        self.assertNotIn('reply', SCHEMA['required'])
