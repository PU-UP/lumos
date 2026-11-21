import uuid
from unittest.mock import patch

import lumos
from lumos_knowledge import material_files, register_material, search_knowledge, read_material, material_detail, material_catalog
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

    def test_preview_reads_only_its_own_files_without_registration(self):
        (self.materials/'private.md').write_text('不应读取', encoding='utf-8')
        (self.root/'PREVIEW').touch(); folder = self.root/'project-materials'; folder.mkdir()
        (folder/'模拟.md').write_text('仅查阅的正文', encoding='utf-8')
        seq = self.store.status()['seq']
        self.assertEqual([f['path'] for f in material_catalog(self.store)], ['模拟.md'])
        read = read_material(self.store, '模拟.md')
        self.assertEqual(read['excerpt'], '仅查阅的正文')
        self.assertEqual(read['operation'], 'read_only')
        self.assertEqual(self.store.status()['seq'], seq)
        self.assertEqual(search_knowledge(self.store, query='仅查阅')['results'], [])
        with self.assertRaises(lumos.Error):
            read_material(self.store, 'private.md')

    def test_fixed_versions_and_exact_references_remain_available(self):
        path = self.materials/'条件.md'; path.write_text('旧条件', encoding='utf-8')
        request = self.request(path.name); old = register_material(self.store, request)['material']
        batch = self.store.begin({'reason': 'exact material link', 'links': [['talk', old['id'], 'derived_from']]}, True)
        self.store.commit(batch['batch'], True)
        path.write_text('新条件', encoding='utf-8')
        register_material(self.store, self.request(path.name))
        detail = material_detail(self.store, old['id'], revision=1)
        self.assertEqual(detail['material']['data']['text'], '旧条件')
        self.assertEqual([n['id'] for n in detail['affected']], ['talk'])
        self.assertEqual([v['revision'] for v in detail['versions']], [2, 1])
        with self.assertRaises(lumos.Error):
            material_detail(self.store, old['id'], workspace='lumos')
        from lumos_agents import episodes
        reports = episodes(self.store)['lumos_reports']
        self.assertEqual(len(reports), 2)
        self.assertTrue(register_material(self.store, request)['replayed'])
        self.assertEqual(len(episodes(self.store)['lumos_reports']), 2)

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

    def test_files_remain_visible_when_many_source_fragments_match(self):
        with self.store.db() as db:
            saved = self.store.nodes(db)
        fragments = {f'fragment-{i}': {'id': f'fragment-{i}', 'kind': 'evidence',
                     'data': {'context': 'mapping', 'text': '标定来源'}} for i in range(105)}
        with patch.object(self.store, 'nodes', return_value={**fragments, **saved}):
            found = search_knowledge(self.store, query='标定')
        self.assertEqual(found['total'], 107)
        self.assertEqual([h['kind'] for h in found['results'][:2]], ['document', 'document'])
        self.assertEqual(len(found['results']), 100)

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
