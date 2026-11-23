"""Source-backed conversation messages. Reading never resolves business questions."""
import copy
import re

from lumos import digest, now, process_lock, require
from lumos_tasks import commit_tasks, task_numbers


def notice(key, kind, text, source_id, related_ids, **extra):
    return {'id': digest((key+'\n'+text).encode())[:32], 'key': key, 'kind': kind,
            'text': text, 'source_id': source_id, 'related_ids': list(dict.fromkeys(related_ids))[:20],
            'at': now(), 'seen_at': '', 'active': True, **extra}


def validate_notices(items, role, workspace, nodes, previous=()):
    require(isinstance(items, list), 'Invalid conversation messages')
    originals = {i['id']: i for i in previous}
    ids = set()
    for item in items:
        require(isinstance(item, dict) and set(item) == {'id', 'key', 'kind', 'text', 'source_id',
                'related_ids', 'at', 'seen_at', 'active', *({'question_key'} if 'question_key' in item else set()), *({'followup_keys'} if 'followup_keys' in item else set())}, 'Invalid message fields')
        require(isinstance(item['id'], str) and re.fullmatch('[a-f0-9]{32}', item['id']) and item['id'] not in ids, 'Invalid message ID')
        ids.add(item['id'])
        require(item['kind'] in {'reply', 'question', 'followup', 'update', 'ops'}, 'Invalid message kind')
        require(item['kind'] == 'reply' or role in {'lumos', 'maintainer'}, '专业角色须先向 Lumos 汇报')
        require((item['kind'] != 'ops' or role == 'maintainer') and
                (item['kind'] not in {'question', 'followup', 'update'} or role == 'lumos'), 'Invalid reporting route')
        require(all(isinstance(item[k], str) for k in ('key', 'text', 'source_id', 'at', 'seen_at')) and item['text'].strip(), 'Invalid message text')
        require(type(item['active']) is bool and isinstance(item['related_ids'], list) and len(item['related_ids']) <= 20, 'Invalid message references')
        old = originals.get(item['id'])
        if old:
            require({k: v for k, v in item.items() if k not in {'seen_at', 'active'}} ==
                    {k: v for k, v in old.items() if k not in {'seen_at', 'active'}}, '已送达消息须保留原文与来源')
            require(not old['seen_at'] or item['seen_at'] == old['seen_at'], '已读记录不能撤销或改写')
        from lumos_tasks import context_workspace
        for ident in [item['source_id'], *item['related_ids']]:
            require(isinstance(ident, str) and ident in nodes, 'Message source missing')
            n = nodes[ident]; d = n['data']
            scope = d.get('workspace') or context_workspace(n if n['kind'] == 'context' else nodes.get(d.get('context'), {'id': '', 'data': {}}))
            # A later task move cannot rewrite or invalidate an already delivered message.
            require(old or scope == workspace, 'Message source outside workspace')
        if 'followup_keys' in item:
            require(item['kind'] == 'followup' and isinstance(item['followup_keys'], list) and 0 < len(item['followup_keys']) <= 20
                    and all(isinstance(k, str) and k.startswith('followup:') and len(k) <= 500 for k in item['followup_keys']), 'Invalid followup keys')
        if 'question_key' in item:
            require(isinstance(item['question_key'], str) and item['question_key'].startswith('question:'+item['source_id']+':'), 'Invalid question reference')
    require(set(originals) <= ids, '历史消息不能移除')


def conversation_topic(nodes, refs):
    """Group only exact task membership, never similar words or broad contexts."""
    refs = {i for i in refs if i in nodes and nodes[i]['kind'] in {'action', 'mainline'}}
    lines = [i for i, n in nodes.items() if n['kind'] == 'mainline' and n['data'].get('status') != 'archived'
             and refs and refs <= {i, *n['data'].get('task_ids', [])}]
    if len(lines) == 1:
        return lines[0]
    return next(iter(refs)) if len(refs) == 1 else ''


def attention_events(nodes, workspace, numbers, today):
    from lumos_intake import scoped_nodes
    from lumos_followup import followup_questions
    from lumos_ops import issue_groups
    scope = scoped_nodes(nodes, workspace)
    pending_keys = {k for n in nodes.values() if n['kind'] == 'intake' and n['data']['workspace'] == workspace
                    and n['data']['status'] in {'pending', 'running'}
                    for k in n['data'].get('question_keys', [n['data'].get('question_key', '')])}
    events = []; questioned = set()
    for q in followup_questions(nodes, workspace, numbers):
        refs = list(dict.fromkeys([*q['task_ids'], *q['related_ids']]))
        refs = [i for i in refs if i in scope][:20]
        questioned.update(q['task_ids'])
        key = 'question:'+q['intake_id']+':'+str(q['index'])
        if key in pending_keys or q.get('follow_up_on', '') > today:
            continue
        source = nodes[q['intake_id']]['data']
        # Ops talks directly to the owner; business specialists report through Lumos.
        if source.get('agent_role') == 'maintainer':
            continue
        source_chat = nodes.get('chat-'+source.get('chat_id', ''), {}).get('data', {})
        if source_chat.get('agent_role') == 'lumos' and not q['answer_state'] and any(
                i['kind'] == 'reply' and i['source_id'] == q['intake_id'] for i in source_chat.get('notices', [])):
            continue  # The original answer already carries this question and its unread receipt.
        title = next((scope[i]['data'].get('title') or scope[i]['data'].get('text') for i in refs), source.get('title') or q['question'][:60])
        events.append(('lumos', title, notice('question:'+key+':'+q.get('follow_up_on', ''), 'question', q['question'], q['intake_id'], refs, question_key=key)))
    groups = {}
    for ident, n in scope.items():
        d = n['data']
        if n['kind'] != 'action' or d['status'] in {'done', 'cancelled'} or ident in questioned or not d.get('follow_up') or d['follow_up'] > today:
            continue
        topic = conversation_topic(scope, [ident]) or ident
        groups.setdefault(topic, []).append(n)
    handled = {k for n in nodes.values() if n['kind'] == 'intake' and n['data']['workspace'] == workspace
               and n['data']['status'] in {'pending', 'running', 'done', 'needs_review'}
               for k in n['data'].get('question_keys', [n['data'].get('question_key', '')])}
    for topic, tasks in groups.items():
        tasks = sorted((n for n in tasks if 'followup:'+n['id']+':'+n['data']['follow_up'] not in handled), key=lambda n: n['id'])
        title = scope[topic]['data'].get('title') or scope[topic]['data']['text']
        for offset in range(0, len(tasks), 19):
            part = tasks[offset:offset+19]
            keys = ['followup:'+n['id']+':'+n['data']['follow_up'] for n in part]
            key = keys[0] if len(keys) == 1 else 'followup:'+topic+':'+digest('|'.join(keys).encode())[:16]
            if key in handled:
                continue
            names = '、'.join(n['data']['text'] for n in part)
            text = '到了跟进时间。'+names+' 有什么新进展或阻碍？只需概括有变化的部分；暂无变化也可以直接告诉我。'
            refs = list(dict.fromkeys([topic, *[n['id'] for n in part]]))
            events.append(('lumos', title, notice(key, 'followup', text, topic, refs, followup_keys=keys)))
    for issue in issue_groups(nodes, workspace):
        key = 'ops:'+issue['key']
        if issue['status'] in {'recovered', 'rechecked'}:
            if not any(n['kind'] == 'conversation' and n['data']['workspace'] == workspace and
                       any(i['key'] == key for i in n['data'].get('notices', [])) for n in nodes.values()):
                continue  # Do not replay recovered historical incidents on first activation.
            text = '运行情况已更新：'+issue.get('impact', issue['summary'])
        else:
            text = issue['summary'] + ('\n'+issue['impact'] if issue.get('impact') else '')
            if issue.get('diagnosis'):
                text += '\nOps 核对结果：'+issue['diagnosis']
        events.append(('maintainer', issue.get('title') or '运行异常', notice(key, 'ops', text, issue['episode_id'], [])))
    # Only newly delivered, durably recorded replies participate; old history is not replayed.
    for chat in nodes.values():
        d = chat['data']
        if chat['kind'] != 'conversation' or d['workspace'] != workspace or d['agent_role'] not in {'aipm', 'librarian'}:
            continue
        for item in d.get('notices', []):
            source = nodes.get(item['source_id'], {}).get('data', {})
            report = source.get('lumos_report', {})
            if item['kind'] == 'reply' and report.get('decision') and source.get('destinations'):
                refs = list(dict.fromkeys(i for i in [*source.get('related_ids', []), *source.get('destinations', [])]
                                          if i in scope and scope[i]['kind'] in {'action', 'mainline'}))[:20]
                events.append(('lumos', d['title'], notice('update:'+item['source_id'], 'update', source['summary'], item['source_id'], refs)))
    return events


def synchronize_attention(store):
    from lumos_conversations import conversation_node
    from lumos_intake import enabled, today, scoped_nodes
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            if db.execute('PRAGMA user_version').fetchone()[0] != 2:
                return 0
            nodes = store.nodes(db); numbers = task_numbers(db)
        updates = {}
        for workspace in ('lingguang', 'lumos'):
            if not enabled(nodes, workspace):
                continue
            scope = scoped_nodes(nodes, workspace)
            events = attention_events(nodes, workspace, numbers, today())
            active = {item['id'] for _, _, item in events}
            chats = {i: copy.deepcopy(n) for i, n in nodes.items() if n['kind'] == 'conversation' and n['data']['workspace'] == workspace}
            for chat in chats.values():
                for item in chat['data'].get('notices', []):
                    if item['kind'] != 'reply':
                        item['active'] = item['id'] in active
            for role, title, item in events:
                existing = next((n for n in chats.values() if any(x['id'] == item['id'] for x in n['data'].get('notices', []))), None)
                if existing:
                    continue
                source_chat = nodes[item['source_id']]['data'].get('chat_id')
                topic = conversation_topic(scope, item['related_ids'])
                candidates = [n for n in chats.values() if n['data']['agent_role'] == role and n['data']['status'] == 'active' and not n['data'].get('deleted')
                              and (any(x['key'] == item['key'] for x in n['data'].get('notices', [])) or
                                   (n['data']['chat_id'] == source_chat and not topic) or
                                   (topic and (n['data'].get('topic_id') or conversation_topic(scope, n['data']['source_ids'])) == topic))]
                if candidates:
                    chat = max(candidates, key=lambda n: n['data']['updated_at'])
                else:
                    chat_id = digest((workspace+role+item['key']).encode())[:32]
                    # A manually closed conversation remains intact.
                    if 'chat-'+chat_id in chats:
                        chat_id = digest((chat_id+item['id']).encode())[:32]
                    chat = conversation_node(chat_id, role, workspace, title[:80])
                    chat['data']['title_mode'] = 'auto'; chats[chat['id']] = chat
                d = chat['data']; d.setdefault('notices', []).append(item)
                if topic and not d.get('topic_id'): d['topic_id'] = topic
                d['source_ids'] = list(dict.fromkeys([*d['source_ids'], *item['related_ids']]))[-20:]
                d['topic_state'] = 'waiting' if item['kind'] in {'question', 'followup'} else 'ongoing'
            for ident, chat in chats.items():
                old = nodes.get(ident)
                if chat != old:
                    chat['data']['revision'] = old['data']['revision']+1 if old else 1
                    chat['data']['updated_at'] = now(); updates[ident] = chat
        if updates:
            commit_tasks(store, nodes, {'reason': '接续确切问题、跟进及运行消息', 'updates': list(updates.values())}, next(iter(updates)))
        return len(updates)


def read_attention(store, request):
    require(set(request) <= {'chat_id', 'ids', 'workspace', 'source'}, 'Invalid read receipt')
    ids = request.get('ids'); chat_id = request.get('chat_id')
    require(isinstance(chat_id, str) and re.fullmatch('[a-f0-9]{32}', chat_id), 'Invalid chat ID')
    require(isinstance(ids, list) and 0 < len(ids) <= 200 and all(isinstance(i, str) for i in ids), 'Invalid read IDs')
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            nodes = store.nodes(db)
        old = nodes.get('chat-'+chat_id)
        require(old and old['kind'] == 'conversation' and old['data']['workspace'] == request.get('workspace'), 'Conversation not in workspace')
        require(set(ids) <= {i['id'] for i in old['data'].get('notices', [])}, 'Unknown message')
        node = copy.deepcopy(old)
        for item in node['data'].get('notices', []):
            if item['id'] in ids and not item['seen_at']:
                item['seen_at'] = now()
        if node != old:
            node['data']['revision'] += 1
            commit_tasks(store, nodes, {'reason': '对话消息已读；不解决业务问题', 'updates': [node]}, node['id'])
        return {'conversation': node}
