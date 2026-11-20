import uuid
from unittest.mock import patch

import lumos
from lumos_knowledge import material_files, register_material, search_knowledge
from test_core import BaseStoreCase


class KnowledgeTest(BaseStoreCase):
    def setUp(self):
        super().setUp(); self.seed()
        self.materials = self.area/'materials'; self.materials.mkdir()
        self.patch = patch('lumos_knowledge.MATERIAL_ROOT', self.materials)
        self.patch.start(); self.addCleanup(self.patch.stop)

    def request(self, path):
        return {'request_id': uuid.uuid4().hex, 'path': path, 'context': 'mapping',
                'source': {'type': 'user', 'ref': 'ISOLATED MATERIAL TEST'}}

    def test_registration_keeps_versions_and_retry_does_not_reread_original(self):
        path = self.materials/'记录.md'; path.write_text('同步旧结果', encoding='utf-8')
        request = self.request(path.name)
        old = register_material(self.store, request)['material']
        path.write_text('同步新结果', encoding='utf-8')
        new = register_material(self.store, self.request(path.name))['material']
        self.assertEqual(new['id'], old['id'])
        self.assertEqual(new['data']['revision'], 2)
        self.assertNotEqual(new['data']['material']['sha256'], old['data']['material']['sha256'])
        self.assertEqual((self.root/old['data']['material']['version']).read_text(encoding='utf-8'), '同步旧结果')
        path.unlink()
        self.assertTrue(register_material(self.store, request)['replayed'])
        found = search_knowledge(self.store, query='新结果')['results'][0]
        self.assertEqual(found['citation']['sha256'], new['data']['material']['sha256'])
        self.assertEqual(self.store.verify()['integrity'], 'ok')
        (self.root/old['data']['material']['version']).write_text('损坏', encoding='utf-8')
        with self.assertRaises(lumos.Error):
            self.store.verify()

    def test_document_blob_is_searched_by_original_format_and_scoped(self):
        found = search_knowledge(self.store, query='标定')['results']
        self.assertEqual(len(found), 2)
        self.assertTrue(all(h['citation']['version'].endswith('.blob') for h in found))
        self.assertEqual(search_knowledge(self.store, workspace='lumos', query='标定')['results'], [])

    def test_path_escape_refused_and_unsupported_format_not_claimed_as_read(self):
        (self.area/'outside.txt').write_text('outside')
        with self.assertRaises(lumos.Error):
            register_material(self.store, self.request('../outside.txt'))
        (self.materials/'scan.pdf').write_bytes(b'%PDF-test')
        self.assertEqual(material_files()[0]['path'], 'scan.pdf')
        node = register_material(self.store, self.request('scan.pdf'))['material']
        self.assertEqual(node['data']['text'], '')
        self.assertIn('暂不解析', node['data']['material']['extraction'])
        self.assertEqual(search_knowledge(self.store, query='scan')['results'][0]['id'], node['id'])

    def test_html_text_is_inert_and_material_versions_survive_backup(self):
        from lumos_transfer import backup, restore
        (self.materials/'plan.html').write_text('<style>secret-style</style><h1>阶段成果</h1><p>同步 &amp; 标定</p><script>secret-script</script>', encoding='utf-8')
        node = register_material(self.store, self.request('plan.html'))['material']
        self.assertIn('同步 & 标定', node['data']['text'])
        self.assertNotIn('secret', node['data']['text'])
        snapshot = self.area/'snapshot'; backup(self.store, snapshot, True)
        restored = self.area/'restored'; restore(snapshot, restored, sandbox=True)
        copied = lumos.Store(restored)
        self.assertEqual(search_knowledge(copied, query='阶段成果')['results'], search_knowledge(self.store, query='阶段成果')['results'])
