"""Restart guard for the desktop launcher. Only stop the verified idle old server."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lumos import SCHEMA, Store, process_lock, require
from lumos_runtime import runtime_info


# Acquire a process handle before verifying its listener and command line. Keep the
# same handle through termination so a recycled PID cannot select another process.
STOP_LISTENER = r"""
$ErrorActionPreference = 'Stop'
$portOwner = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen)
if ($portOwner.Count -ne 1) { throw 'listener identity unavailable' }
$server = Get-Process -Id $portOwner[0].OwningProcess
$handle = $server.Handle
try {
    $info = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $server.Id)
    $scriptName = [regex]::Escape($env:LUMOS_LAUNCH_SCRIPT)
    $rootName = [regex]::Escape($env:LUMOS_LAUNCH_DATA)
    $pattern = '^\s*(?:"[^"]+"|\S+)\s+(?:-B\s+)?(?:"' + $scriptName + '"|' + $scriptName + ')\s+(?:--data\s+(?:"' + $rootName + '"|' + $rootName + ')\s+)?serve(?:\s+--port\s+8765)?\s*$'
    if ($server.ProcessName -notin @('python','pythonw') -or $info.CommandLine -notmatch $pattern) { throw 'unexpected server command' }
    $client = New-Object System.Net.WebClient
    try {
        $client.Proxy = $null
        $client.Encoding = [System.Text.Encoding]::UTF8
        $health = $client.DownloadString('http://127.0.0.1:8765/api/health') | ConvertFrom-Json
        if ($health.app -ne 'lumos' -or $health.root -ne $env:LUMOS_LAUNCH_DATA -or $health.runtime.code -ne $env:LUMOS_OLD_CODE) { throw 'service changed' }
    } finally { $client.Dispose() }
    $listener = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen)
    if ($server.HasExited -or $listener.Count -ne 1 -or $listener[0].OwningProcess -ne $server.Id) { throw 'listener changed' }
    $server.Kill()
    if (!$server.WaitForExit(5000)) { throw 'server still running' }
} finally { $server.Dispose() }
"""


def guard(store, health, expected):
    require(health.get('app') == 'lumos' and Path(health.get('root', '')).resolve() == store.root
            and health.get('preview') is False, '8765 的服务身份与正式数据目录不匹配。')
    require(health.get('mode') == 'active' and store.writable()['mode'] == 'active', '正式数据当前不可写。')
    runtime = health.get('runtime', {})
    require(health.get('data_schema') == runtime.get('schema') == SCHEMA, '服务或数据结构版本不匹配，请检查迁移状态。')
    require(runtime.get('code') and runtime['code'] != expected['code'], '当前服务未确认是旧版。')
    store.idle()
    with store.db() as db:
        require(db.execute('PRAGMA user_version').fetchone()[0] == SCHEMA, '数据版本已变化。')
        require(not db.execute("SELECT 1 FROM nodes WHERE kind='intake' AND json_extract(data,'$.status') IN ('pending','running') LIMIT 1").fetchone(),
                '后台仍有排队或执行中的任务。请等处理结束后再打开 Lumos。')


def read_health():
    with build_opener(ProxyHandler({})).open('http://127.0.0.1:8765/api/health', timeout=3) as response:
        return json.load(response)


def verify_command(argv, cwd, root, data):
    args = list(argv[1:])
    while args:
        if args[0] in {'-B', '-u', '-E', '-s', '-I', '-O', '-OO'}:
            args.pop(0)
        elif args[:2] == ['-X', 'utf8'] or args[:2] == ['-X', 'utf8=1']:
            del args[:2]
        elif args[0] in {'-Xutf8', '-Xutf8=1'}:
            args.pop(0)
        else:
            break
    require(args and (cwd / args.pop(0)).resolve() == root / 'lumos.py',
            '监听进程的脚本与本仓库 lumos.py 不一致。')
    if args[:1] == ['--data']:
        require(len(args) >= 2 and (cwd / args[1]).resolve() == data, '启动参数中的数据目录与正式目录不一致。')
        del args[:2]
    elif args and args[0].startswith('--data='):
        require((cwd / args.pop(0)[7:]).resolve() == data, '启动参数中的数据目录与正式目录不一致。')
    require(args in (['serve'], ['serve', '--port', '8765'], ['serve', '--port=8765']),
            '监听进程的子命令或端口与正式服务不一致。')


def stop_verified(psutil, store, health):
    def listener():
        owners = {c.pid for c in psutil.net_connections('tcp4')
                  if c.status == psutil.CONN_LISTEN and c.laddr == ('127.0.0.1', 8765)}
        require(len(owners) == 1 and None not in owners, '无法确定 8765 的唯一监听进程。')
        return owners.pop()

    stage = '读取监听端口'
    try:
        proc = psutil.Process(listener())
        stage = f'核对进程 {proc.pid} 的启动参数和工作目录'
        require(Path(proc.exe()).name.lower() in {'python.exe', 'pythonw.exe'}, '监听者不是 Python 服务。')
        verify_command(proc.cmdline(), Path(proc.cwd()), ROOT, store.root)
        stage = '重新核对服务身份'
        latest = read_health()
        require(all(latest.get(k) == health.get(k) for k in ('app', 'root', 'runtime', 'mode', 'preview', 'data_schema'))
                and proc.is_running() and listener() == proc.pid, '核对时服务已变化，请重新打开。')
        stage = f'停止已核实的旧版服务（PID {proc.pid}）'
        proc.terminate()
        proc.wait(timeout=5)
    except (psutil.Error, OSError, RuntimeError) as error:
        raise RuntimeError(f'{stage}失败：{error}') from error


def main():
    store = Store(ROOT / 'lumos-data')
    with process_lock(store.root):
        health = read_health()
        guard(store, health, runtime_info(ROOT))
        try:
            import psutil
        except ImportError:
            pass
        else:
            stop_verified(psutil, store, health)
            return
        shell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        result = subprocess.run([str(shell), '-NoProfile', '-NonInteractive', '-EncodedCommand', base64.b64encode(STOP_LISTENER.encode('utf-16le')).decode('ascii')],
                                env={**os.environ, 'LUMOS_LAUNCH_SCRIPT': str(ROOT / 'lumos.py'),
                                     'LUMOS_LAUNCH_DATA': str(store.root), 'LUMOS_OLD_CODE': health['runtime']['code']}, capture_output=True, timeout=20)
        if result.returncode:
            detail = result.stderr.decode('utf-8', errors='replace').splitlines()
            raise RuntimeError('Windows 监听进程核对失败：' + next((line for line in detail if line.strip()), str(result.returncode))[:300])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stdout.buffer.write(str(error).encode('utf-8'))
        sys.exit(1)
