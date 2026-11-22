import lumos
from lumos_models import role_models, save_role_models, job_models
from lumos_transfer import backup, restore
from test_core import BaseStoreCase


class ModelsTest(BaseStoreCase):
    def test_preferences_validate_conflicts_defaults_readonly_and_backup(self):
        self.assertEqual(role_models(self.store), {})
        before = self.store.status()['seq']
        save_role_models(self.store, {'models': {'lumos': 'coordinator', 'aipm': ''}, 'expected': {'lumos': None, 'aipm': None}})
        for request in ({'models': {'unknown': 'x'}, 'expected': {'unknown': None}},
                        {'models': {'lumos': '--bad'}, 'expected': {'lumos': 'coordinator'}},
                        {'models': {'lumos': 'other'}, 'expected': {'lumos': None}}):
            with self.assertRaises(lumos.Error):
                save_role_models(self.store, request)
        self.assertEqual(self.store.status()['seq'], before)
        snapshot, target = self.area/'models-backup', self.area/'models-restored'
        backup(self.store, snapshot, True); restore(snapshot, target)
        restored = lumos.Store(target)
        self.assertEqual(role_models(restored), {'lumos': 'coordinator', 'aipm': ''})
        with self.assertRaises(lumos.Error):
            save_role_models(restored, {'models': {'lumos': 'x'}, 'expected': {'lumos': 'coordinator'}})

    def test_entry_override_does_not_leak_to_other_roles_or_override_explicit_default(self):
        save_role_models(self.store, {'models': {'lumos': 'coordinator', 'aipm': 'project', 'librarian': 'atlas'},
                                     'expected': {'lumos': None, 'aipm': None, 'librarian': None}})
        models = job_models(self.store, {'agent_role': 'aipm', 'model': ''})
        self.assertEqual((models['aipm'], models['lumos']), ('', 'coordinator'))
        review = job_models(self.store, {'task_review': True, 'agent_role': 'aipm', 'model': 'review-choice'})
        self.assertEqual((review['aipm'], review['lumos']), ('project', 'review-choice'))
        note = job_models(self.store, {'note_mode': 'format', 'model': 'gpt-6.2-astra'})
        self.assertEqual(note['librarian'], 'gpt-6.2-astra')
        self.assertEqual(job_models(self.store, {'role_models': models}), models)
