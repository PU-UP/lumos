"""Data-root model preferences and immutable per-job role selections."""
import json
import os
from pathlib import Path
import re

from lumos import process_lock, read_json, require, safe_path, write_json

RECOMMENDED = {
    'lumos': ('gpt-6.2-astra', 'high'),
    'aipm': ('gpt-6.2-sol', 'medium'),
    'librarian': ('gpt-6.2-sol', 'low'),
    'maintainer': ('gpt-6.2-astra', 'medium'),
}
ROLES = tuple(RECOMMENDED)
LEVELS = ('low', 'medium', 'high', 'xhigh', 'max', 'ultra')


def selectable(model):
    return bool(isinstance(model, str) and model and model.lower() not in {'default', 'executor-default'}
                and not re.match(r'^(?:gpt-)?5\.6(?:[-.]|$)', model, re.I))


def model_catalog():
    """Use the installed client's catalog; never expose its prompts or account settings."""
    try:
        home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
        cache = json.loads((home / 'models_cache.json').read_text(encoding='utf-8'))
        models = []
        for entry in cache['models']:
            if not isinstance(entry, dict) or entry.get('visibility') != 'list':
                continue
            model = entry.get('slug')
            if not selectable(model) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,99}', model):
                continue
            option = {'id': model, 'name': entry.get('display_name') or model}
            supported = entry.get('supported_reasoning_levels') or []
            levels = [row['effort'] for row in supported if isinstance(row, dict) and row.get('effort') in LEVELS]
            if levels:
                option['efforts'] = levels
            models.append(option)
        return {'models': models, 'fetched_at': cache.get('fetched_at', '')}
    except (OSError, ValueError, KeyError, TypeError):
        return {'models': [], 'fetched_at': ''}


def validate_models(models):
    require(isinstance(models, dict) and set(models) <= set(ROLES), 'Invalid role models')
    require(all(isinstance(m, str) and (not m or re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,99}', m))
                for m in models.values()), 'Invalid Codex model')


def preferences(store):
    path = safe_path(store.root, 'role-models.json')
    saved = read_json(path) if path.exists() else {}
    require(isinstance(saved, dict), 'Invalid role settings')
    models = saved.get('models', saved)
    efforts = saved.get('efforts', {})
    validate_models(models)
    require(isinstance(efforts, dict) and all(r in ROLES and e in LEVELS for r, e in efforts.items()),
            'Invalid reasoning settings')
    return {'models': {r: models[r] if selectable(models.get(r)) else m for r, (m, _) in RECOMMENDED.items()},
            'efforts': {r: efforts.get(r, e) if selectable(models.get(r)) else e for r, (_, e) in RECOMMENDED.items()}}


def save_role_models(store, request):
    require(isinstance(request, dict) and set(request) <= {'models', 'expected', 'source', 'efforts', 'expected_efforts'},
            'Invalid model preference request')
    changes, expected = request.get('models'), request.get('expected')
    validate_models(changes)
    require(all(selectable(m) for m in changes.values()), '请选择具体型号，5.6 已停用')
    require(isinstance(expected, dict) and set(expected) == set(changes), 'Expected current role models')
    efforts = request.get('efforts', {})
    prior = request.get('expected_efforts', {})
    require(isinstance(efforts, dict) and isinstance(prior, dict) and set(efforts) == set(prior)
            and set(efforts) <= set(changes) and all(e in LEVELS for e in efforts.values()), 'Invalid reasoning effort')
    catalog = {m['id']: m for m in model_catalog()['models']}
    with process_lock(store.root):
        store.writable(); store.idle()
        settings = preferences(store)
        for role, model in changes.items():
            current = (settings['models'][role], settings['efforts'][role])
            level = efforts.get(role, current[1])
            require(current in ((expected[role], prior.get(role, current[1])), (model, level)),
                    '模型设置已被其他页面改变，请刷新后重选')
            require(level in catalog.get(model, {}).get('efforts', LEVELS), '此模型不支持该推理强度')
            settings['models'][role], settings['efforts'][role] = model, level
        write_json(safe_path(store.root, 'role-models.json'), settings)
    return settings


def freeze_settings(store, data):
    if 'role_models' in data:
        return
    from lumos_agents import role_for
    settings = preferences(store)
    role = 'lumos' if data.get('task_review') or data.get('review') else role_for(data)
    if selectable(data.get('model')):
        settings['models'][role] = data['model']
    if data.get('model') or 'reasoning_effort' in data:
        model = settings['models'][role]
        allowed = next((m['efforts'] for m in model_catalog()['models'] if m['id'] == model and 'efforts' in m), LEVELS)
        level = data.get('reasoning_effort', settings['efforts'][role])
        if 'reasoning_effort' in data:
            require(level in allowed, '此模型不支持该推理强度')
        settings['efforts'][role] = level if level in allowed else allowed[0]
    data.update(role_models=settings['models'], role_efforts=settings['efforts'])


def execution_model(data, role):
    from lumos_agents import role_for
    return data.get('role_models', {}).get(role, data.get('model', '') if role == role_for(data) else '')
