import lumos
from unittest.mock import patch
from lumos_models import freeze_settings, save_role_models, preferences
from lumos_transfer import backup, restore
from test_core import BaseStoreCase


class ModelsTest(BaseStoreCase):
    def test_preferences_validate_conflicts_defaults_readonly_and_backup(self):
        initial = preferences(self.store)
        self.assertEqual(initial['models']['lumos'], 'gpt-6.2-astra')
        before = self.store.status()['seq']
        saved = save_role_models(self.store, {'models': {'lumos': 'gpt-6.2-astra'}, 'expected': {'lumos': initial['models']['lumos']},
                                              'efforts': {'lumos': 'medium'}, 'expected_efforts': {'lumos': 'high'}})
        for request in ({'models': {'aipm': ''}, 'expected': {'aipm': 'gpt-6.2-sol'}},
                        {'models': {'aipm': 'gpt-5.6-sol'}, 'expected': {'aipm': 'gpt-6.2-sol'}},
                        {'models': {'lumos': 'gpt-6.2-astra'}, 'expected': {'lumos': 'gpt-6.2-astra'},
                         'efforts': {'lumos': 'low'}, 'expected_efforts': {'lumos': 'high'}},
                        {'models': {'lumos': 'other'}, 'expected': {'lumos': 'gpt-6.2-astra'},
                         'efforts': {'lumos': 'medium'}, 'expected_efforts': {'lumos': 'high'}},
                        {'models': {'unknown': 'x'}, 'expected': {'unknown': None}},
                        {'models': {'lumos': '--bad'}, 'expected': {'lumos': 'coordinator'}},
                        {'models': {'lumos': 'other'}, 'expected': {'lumos': None}}):
            with self.assertRaises(lumos.Error):
                save_role_models(self.store, request)
        self.assertEqual(self.store.status()['seq'], before)
        snapshot, target = self.area/'models-backup', self.area/'models-restored'
        backup(self.store, snapshot, True); restore(snapshot, target)
        restored = lumos.Store(target)
        self.assertEqual(preferences(restored), saved)
        with self.assertRaises(lumos.Error):
            save_role_models(restored, {'models': {'lumos': 'x'}, 'expected': {'lumos': 'coordinator'}})

    def test_entry_override_does_not_leak_to_other_roles_and_empty_uses_selected_model(self):
        save_role_models(self.store, {'models': {'lumos': 'coordinator', 'aipm': 'project', 'librarian': 'atlas'},
                                     'expected': {r: preferences(self.store)['models'][r] for r in ('lumos', 'aipm', 'librarian')}})
        job = {'agent_role': 'aipm', 'model': ''}
        freeze_settings(self.store, job)
        self.assertEqual((job['role_models']['aipm'], job['role_models']['lumos']), ('project', 'coordinator'))
        review = {'task_review': True, 'agent_role': 'aipm', 'model': 'review-choice'}
        catalog = {'models': [{'id': 'review-choice', 'efforts': ['low']}]}
        with patch('lumos_models.model_catalog', return_value=catalog):
            freeze_settings(self.store, review)
            self.assertEqual((review['role_models']['aipm'], review['role_models']['lumos']), ('project', 'review-choice'))
            self.assertEqual(review['role_efforts']['lumos'], 'low')
            with self.assertRaisesRegex(lumos.Error, '推理强度'):
                freeze_settings(self.store, {'model': 'review-choice', 'reasoning_effort': 'high'})
        note = {'note_mode': 'format', 'model': 'gpt-6.2-astra'}
        freeze_settings(self.store, note)
        self.assertEqual(note['role_models']['librarian'], 'gpt-6.2-astra')
        historical = {'role_models': job['role_models']}
        freeze_settings(self.store, historical)
        self.assertNotIn('role_efforts', historical)
