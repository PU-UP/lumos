"""Data-root model preferences and immutable per-job role selections."""
import re

from lumos import process_lock, read_json, require, safe_path, write_json

ROLES = ('lumos', 'aipm', 'librarian', 'maintainer')


def validate_models(models):
    require(isinstance(models, dict) and set(models) <= set(ROLES), 'Invalid role models')
    require(all(isinstance(m, str) and (not m or re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,99}', m))
                for m in models.values()), 'Invalid Codex model')


def role_models(store):
    path = safe_path(store.root, 'role-models.json')
    models = read_json(path) if path.exists() else {}
    validate_models(models)
    return models


def save_role_models(store, request):
    require(isinstance(request, dict) and set(request) <= {'models', 'expected', 'source'}, 'Invalid model preference request')
    changes, expected = request.get('models'), request.get('expected')
    validate_models(changes)
    require(isinstance(expected, dict) and set(expected) == set(changes), 'Expected current role models')
    validate_models({r: m for r, m in expected.items() if m is not None})
    with process_lock(store.root):
        store.writable(); store.idle()
        models = role_models(store)
        require(all(models.get(r) in (expected[r], m) for r, m in changes.items()), '模型设置已在其他页面改变，请刷新后重选')
        models.update(changes)
        write_json(safe_path(store.root, 'role-models.json'), models)
    return {'models': models}


def job_models(store, data):
    if 'role_models' in data:
        return data['role_models']
    from lumos_agents import role_for
    selected = role_models(store)
    models = {r: selected.get(r, '') for r in ROLES}
    if 'model' in data:
        models['lumos' if data.get('task_review') or data.get('review') else role_for(data)] = data['model']
    return models


def execution_model(data, role):
    from lumos_agents import role_for
    # Unclaimed legacy jobs have no snapshot; their explicit model belongs only to the entry role.
    return data.get('role_models', {}).get(role, data.get('model', '') if role == role_for(data) else '')
