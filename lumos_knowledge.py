"""Bounded local retrieval and immutable copies of explicitly registered materials."""
import json
import os
from pathlib import Path
import re
import zipfile
from xml.etree import ElementTree
from html.parser import HTMLParser

from lumos import ENGINE, atomic, digest, now, process_lock, require, safe_path
from lumos_tasks import commit_tasks, context_workspace

MATERIAL_ROOT = ENGINE / 'project-materials'
MAX_BYTES = 20 * 1024 * 1024
TEXT_BYTES = 2 * 1024 * 1024


class HTMLText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style'}:
            self.hidden += 1
        elif tag in {'p', 'div', 'li', 'br', 'tr', 'h1', 'h2', 'h3'}:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in {'script', 'style'} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def extracted(path, suffix=None):
    suffix = suffix or path.suffix.lower()
    if suffix in {'.md', '.txt', '.csv', '.json', '.log', '.html', '.htm'}:
        if path.stat().st_size > TEXT_BYTES:
            return '', '文件过大，仅登记原件'
        try:
            text = path.read_text(encoding='utf-8-sig')
            if suffix in {'.html', '.htm'}:
                parser = HTMLText(); parser.feed(text)
                return ''.join(parser.parts), '已提取网页文字（不执行脚本、不读取外链）'
            return text, '已读取文本'
        except UnicodeError:
            return '', '编码未识别，仅登记原件'
    if suffix in {'.docx', '.pptx'}:
        try:
            with zipfile.ZipFile(path) as archive:
                members = [i for i in archive.infolist() if i.filename == 'word/document.xml'
                           or re.fullmatch(r'ppt/slides/slide\d+\.xml', i.filename)]
                require(sum(i.file_size for i in members) <= TEXT_BYTES, '文档展开过大')
                members.sort(key=lambda i: int(re.search(r'(\d+)\.xml', i.filename)[1]) if i.filename.startswith('ppt/') else 0)
                parts = []
                for member in members:
                    root = ElementTree.fromstring(archive.read(member))
                    parts.extend(''.join(t.text or '' for t in p.iter() if t.tag.endswith('}t'))
                                 for p in root.iter() if p.tag.endswith('}p'))
                return '\n'.join(parts)[:200000], '已提取正文文字（不含图片、批注和版式）'
        except (OSError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
            return '', '文档无法提取，仅登记原件'
    return '', '暂不解析此格式，仅登记原件'


def material_files():
    if not MATERIAL_ROOT.exists():
        return []
    require(not MATERIAL_ROOT.is_symlink() and not MATERIAL_ROOT.is_junction(), '资料目录不能是链接')
    files = []
    for folder, dirs, names in os.walk(MATERIAL_ROOT, followlinks=False):
        for name in dirs + names:
            rel = (Path(folder)/name).relative_to(MATERIAL_ROOT).as_posix()
            path = safe_path(MATERIAL_ROOT, rel)
            if path.is_file():
                files.append({'path': rel, 'size': path.stat().st_size})
                require(len(files) <= 2000, '资料超过2000份，请先缩小 project-materials 范围')
    return sorted(files, key=lambda f: f['path'])


def register_material(store, request):
    require(isinstance(request, dict) and set(request) == {'request_id', 'path', 'context', 'source'}, 'Invalid material request')
    require(isinstance(request['request_id'], str) and re.fullmatch('[a-f0-9]{32}', request['request_id']), 'Invalid request ID')
    reason = 'material:'+request['request_id']+':'+digest(json.dumps(request, sort_keys=True).encode())
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            replay = db.execute('SELECT reason,manifest FROM batches WHERE reason LIKE ?', ('material:'+request['request_id']+':%',)).fetchone()
            if replay:
                require(replay[0] == reason, 'Request ID reused with different content')
                return {'material': json.loads(replay[1])['request']['updates'][0], 'replayed': True}
            nodes = store.nodes(db)
        context = nodes.get(request['context'], {})
        require(context.get('kind') == 'context' and context['data'].get('status', 'active') in {'active', 'waiting'}, '需要当前脉络承接资料')
        require(not MATERIAL_ROOT.is_symlink() and not MATERIAL_ROOT.is_junction(), '资料目录不能是链接')
        path = safe_path(MATERIAL_ROOT, request['path'])
        require(path.is_file() and path.stat().st_size <= MAX_BYTES, '资料不存在或超过20MB')
        raw = path.read_bytes()
        require(len(raw) <= MAX_BYTES, '资料超过20MB')
        sha = digest(raw)
        rel = 'sources/materials/'+sha+path.suffix.lower()
        target = safe_path(store.root, rel)
        if target.exists():
            require(digest(target.read_bytes()) == sha, '已保存的资料版本损坏')
        else:
            atomic(target, raw)
        text, state = extracted(target)
        canonical = path.relative_to(MATERIAL_ROOT).as_posix()
        ident = 'material-'+digest((request['context']+'\n'+(canonical.casefold() if os.name == 'nt' else canonical)).encode())[:32]
        old = nodes.get(ident, {}).get('data', {})
        node = {'id': ident, 'kind': 'evidence', 'data': {'context': request['context'], 'title': path.name,
            'text': text, 'source': request['source'], 'material': {'path': request['path'], 'version': rel,
                'sha256': sha, 'size': len(raw), 'extraction': state}, 'revision': old.get('revision', 0)+1, 'updated_at': now()}}
        commit_tasks(store, nodes, {'reason': reason, 'updates': [node]}, ident)
        return {'material': node, 'replayed': False}


def search_knowledge(store, workspace='lingguang', query='', archived=False):
    require(workspace in {'lingguang', 'lumos'} and isinstance(query, str) and len(query) <= 500, 'Invalid knowledge query')
    with process_lock(store.root), store.db() as db:
        nodes = store.nodes(db)
        contexts = {i: n for i, n in nodes.items() if n['kind'] == 'context' and context_workspace(n) == workspace
                    and (archived or n['data'].get('status', 'active') in {'active', 'waiting'})}
        hits = []
        for n in nodes.values():
            d, kind = n['data'], n['kind']
            if kind == 'note':
                if d['workspace'] != workspace or d['status'] == 'deleted' or (not archived and d['status'] == 'archived'):
                    continue
                text, citation = d['body'], {'id': n['id'], 'revision': d['revision']}
            elif kind in {'evidence', 'document'} and d.get('context') in contexts:
                text = d.get('text', '')
                citation = {'id': n['id']}
                if kind == 'document':
                    path = safe_path(store.root, d['version'])
                    require(path.stat().st_size <= MAX_BYTES, '文档过大：'+n['id'])
                    require(digest(path.read_bytes()) == d['sha256'], '文档固定版本损坏：'+n['id'])
                    text, _ = extracted(path, Path(d['path']).suffix.lower())
                    citation.update(version=d['version'], sha256=d['sha256'])
                if d.get('material'):
                    citation.update(version=d['material']['version'], sha256=d['material']['sha256'])
            else:
                continue
            title = d.get('title') or d.get('text', '')[:100]
            haystack = (title+'\n'+text).casefold()
            terms = query.casefold().split()
            if terms and not all(t in haystack for t in terms):
                continue
            index = text.casefold().find(terms[0]) if terms else 0
            start = max(0, index-80)
            hits.append({'id': n['id'], 'kind': kind, 'title': title, 'citation': citation,
                         'has_title': bool(d.get('title')), 'is_material': bool(d.get('material')),
                         'context_title': contexts.get(d.get('context'), {}).get('data', {}).get('title', ''),
                         'excerpt': text[start:start+1200], 'truncated': len(text) > 1200,
                         'extraction': d.get('material', {}).get('extraction', '已读取文本'),
                         'context': d.get('context', ''), 'archived': d.get('status') == 'archived'})
        hits.sort(key=lambda h: 0 if h['kind'] == 'document' or h['is_material'] else 1 if h['kind'] == 'note' else 2)
        return {'results': hits[:100], 'total': len(hits), 'contexts': [{'id': i, 'title': n['data']['title']} for i, n in contexts.items()
                                                                   if n['data'].get('status', 'active') in {'active', 'waiting'}]}


def knowledge_catalog(store, workspace='lingguang'):
    """Opening the search page needs project choices, not every saved source fragment."""
    require(workspace in {'lingguang', 'lumos'}, 'Invalid workspace')
    with process_lock(store.root), store.db() as db:
        contexts = [n for n in store.nodes(db).values() if n['kind'] == 'context' and context_workspace(n) == workspace
                    and n['data'].get('status', 'active') in {'active', 'waiting'}]
        return {'contexts': [{'id': n['id'], 'title': n['data']['title']} for n in contexts]}
