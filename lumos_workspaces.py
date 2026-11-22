"""Explicit, versioned consolidation of legacy workspace classifications."""
import copy

from lumos import process_lock, require
from lumos_tasks import context_workspace

MODE = 'lumos-workspace-mode'


def is_unified(nodes):
    node = nodes.get(MODE, {})
    return node.get('kind') == 'decision' and node['data'].get('workspace_mode') == 'unified'


def unify_workspace(store, quiet=False):
    require(quiet, '统一前须暂停全部写入，并指定 --quiet-files')
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            old = store.nodes(db)
        if is_unified(old):
            return {'workspace': 'lingguang', 'changed': 0, 'replayed': True}
        require(not any(n['kind'] == 'intake' and n['data']['status'] in {'pending', 'running'} for n in old.values()),
                '仍有处理中输入，不能统一空间')
        # Conversation identity is immutable; legacy chats must be consolidated before role upgrade.
        require(not any(n['kind'] == 'conversation' and n['data']['workspace'] == 'lumos' for n in old.values()),
                '已有仓库空间的四角色对话，需单独保留身份迁移；本操作未修改记录')
        contexts = [n for n in old.values() if n['kind'] == 'context']
        require(contexts, '没有可接续的项目背景')
        context = 'work-current' if 'work-current' in old else contexts[0]['id']
        updates = []
        for node in old.values():
            updated = copy.deepcopy(node); d = updated['data']
            if node['kind'] == 'context' and context_workspace(node) == 'lumos':
                d['workspace'] = 'lingguang'
            if node['kind'] in {'note', 'intake'} and d.get('workspace') == 'lumos':
                d['workspace'] = 'lingguang'; d['revision'] += 1
            if node['kind'] == 'person' and 'lumos' in d['workspaces']:
                d['workspaces'] = list(dict.fromkeys('lingguang' if s == 'lumos' else s for s in d['workspaces']))
            if node['id'] == 'lumos-autonomy-policy':
                for field in ('autonomy_workspaces', 'task_management_workspaces', 'ops_inspection_workspaces'):
                    if field in d:
                        d[field] = list(dict.fromkeys('lingguang' if s == 'lumos' else s for s in d[field]))
            if updated != node:
                updates.append(updated)
        updates.append({'id': MODE, 'kind': 'decision', 'data': {'context': context,
            'title': '统一工作区', 'text': '全部工作由四角色共同接续，不再按灵光和仓库维护拆分入口。',
            'workspace_mode': 'unified', 'reason': '用户明确要求合并两个项目入口，保留任务、笔记与历史。',
            'scope': '当前工作空间分类；不改任务承诺或笔记正文',
            'source': {'type': 'user', 'ref': '用户授权统一工作区；显式 unify-workspace 命令'}}})
        request = {'reason': '用户授权统一工作区；旧分类保留在版本历史，不导入模拟数据', 'updates': updates}
        with store.db() as db:
            links = set(db.execute('SELECT src,dst,relation FROM links'))
        store.validate(old, {**old, **{n['id']: n for n in updates}}, request, links, links)
        batch = store._begin(request)
        store._commit(batch['batch'])
        with store.db() as db:
            current = store.nodes(db)
        require(all(current[n['id']] == n for n in updates), '统一后的记录读回不一致')
        return {'workspace': 'lingguang', 'changed': len(updates), 'batch': batch['batch'], 'replayed': False}
