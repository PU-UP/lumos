"""Identify the source loaded at service startup; never upgrade data implicitly."""
from lumos import ENGINE, SCHEMA, digest


def runtime_info(root=ENGINE):
    files = sorted([*root.glob('lumos*.py'), *(root/'web').rglob('*')])
    manifest = '\n'.join(p.relative_to(root).as_posix() + ':' + digest(p.read_bytes())
                         for p in files if p.is_file())
    return {'code': digest(manifest.encode()), 'schema': SCHEMA}
