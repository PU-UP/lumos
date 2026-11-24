import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import lumos
from lumos_runtime import runtime_info
from lumos_web import serve, make_server
from test_core import BaseStoreCase


class RuntimeTest(BaseStoreCase):
    def test_port_is_exclusive_and_second_service_cannot_start_a_worker(self):
        with make_server(self.store, 0) as first:
            with patch('lumos_worker.Worker') as worker:
                with self.assertRaises(OSError):
                    serve(self.store, first.server_port)
                worker.assert_not_called()

    def test_fingerprint_changes_with_code_and_web_without_touching_data(self):
        root = self.area/'engine'; root.mkdir(); (root/'web').mkdir()
        (root/'lumos.py').write_text('first')
        before = runtime_info(root)
        (root/'web'/'chat.js').write_text('new')
        self.assertNotEqual(before, runtime_info(root))
        before = runtime_info(root)
        (root/'lumos.py').write_text('second')
        self.assertNotEqual(before, runtime_info(root))
        result = subprocess.run([sys.executable, '-B', str(lumos.ENGINE/'lumos.py'), '--data', str(self.area/'absent'), 'runtime-info'],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), runtime_info())
        self.assertFalse((self.area/'absent').exists())

    def test_launcher_recovers_only_idle_matching_formal_store_with_stale_code(self):
        from tools.restart_idle_service import guard
        health = {'app': 'lumos', 'root': str(self.root), 'mode': 'active', 'preview': False,
                  'data_schema': lumos.SCHEMA, 'runtime': {'code': 'old', 'schema': lumos.SCHEMA}}
        expected = {'code': 'new'}
        guard(self.store, health, expected)
        for override in ({'app': 'other'}, {'root': str(self.area)}, {'preview': True},
                         {'mode': 'trial'}, {'data_schema': 1}, {'runtime': {'code': 'new', 'schema': lumos.SCHEMA}}):
            with self.assertRaises(lumos.Error):
                guard(self.store, {**health, **override}, expected)
        for status in ('pending', 'running'):
            with self.store.db(True) as db:
                db.execute('insert or replace into nodes values (?,?,?)', ('job', 'intake', json.dumps({'status': status})))
            with self.assertRaises(lumos.Error):
                guard(self.store, health, expected)

    def test_launcher_validates_resolved_script_and_real_service_arguments(self):
        from tools.restart_idle_service import verify_command
        root = self.area.resolve()
        data = root / 'lumos-data'
        verify_command(['python', '-X', 'utf8', '-u', 'lumos.py', '--data', 'lumos-data', 'serve'], root, root, data)
        verify_command(['python', '-B', str(root / 'lumos.py'), 'serve', '--port=8765'], data, root, data)
        for args, cwd in [(['lumos.py', 'serve'], data), (['other.py', 'serve'], root),
                          (['lumos.py', 'serve', '--port', '8775'], root), (['lumos.py', '--data', 'other', 'serve'], root)]:
            with self.assertRaises(lumos.Error):
                verify_command(['python', *args], cwd, root, data)

    def test_old_schema_cannot_start_background_worker(self):
        with self.store.db(True) as db:
            db.execute('PRAGMA user_version=1')
        with patch('lumos_web.make_server') as server:
            with self.assertRaisesRegex(lumos.Error, 'upgrade-roles'):
                serve(self.store, 0)
            server.assert_not_called()
        with self.store.db() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_windows_launcher_rejects_stale_version_schema_worker_and_preview(self):
        compiler = Path(os.environ.get('WINDIR', 'C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        if not compiler.exists():
            self.skipTest('Windows C# compiler unavailable')
        harness = self.area/'LauncherChecks.cs'
        harness.write_text('''using System;
using System.Collections.Generic;
using System.Reflection;
using System.Web.Script.Serialization;
class LauncherChecks {
 static void Main() {
  var method = typeof(LumosLauncher).GetMethod("Matches", BindingFlags.NonPublic | BindingFlags.Static);
  var json = new JavaScriptSerializer();
  var expected = json.Deserialize<Dictionary<string,object>>("{\\"code\\":\\"new\\",\\"schema\\":2}");
  string valid = "{\\"app\\":\\"lumos\\",\\"root\\":\\"DATA\\",\\"runtime\\":{\\"code\\":\\"new\\",\\"schema\\":2},\\"data_schema\\":2,\\"mode\\":\\"active\\",\\"preview\\":false,\\"worker\\":{\\"state\\":\\"available\\"}}";
  Func<string,bool> match = s => (bool)method.Invoke(null, new object[]{json.Deserialize<Dictionary<string,object>>(s), "data", expected});
  if (!match(valid)) throw new Exception("valid rejected");
  foreach (string bad in new string[]{"{}", valid.Replace("new", "old"), valid.Replace("DATA", "OTHER"), valid.Replace("data_schema\\":2", "data_schema\\":1"), valid.Replace("available", "stopped"), valid.Replace("false", "true"), valid.Replace("active", "readonly")})
   if (match(bad)) throw new Exception("invalid accepted: " + bad);
 }
}''', encoding='utf-8')
        exe = self.area/'checks.exe'
        subprocess.run([str(compiler), '/nologo', '/target:exe', '/main:LauncherChecks', '/reference:System.Windows.Forms.dll',
                        '/reference:System.Web.Extensions.dll', '/out:'+str(exe), str(lumos.ENGINE/'tools/LumosLauncher.cs'), str(harness)],
                       capture_output=True, check=True)
        subprocess.run([str(exe)], check=True, capture_output=True)
