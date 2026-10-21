using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class LumosLauncher
{
    const string Url = "http://127.0.0.1:8765/";

    static bool Ready(string data)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "api/health");
            request.Proxy = null;
            request.Timeout = 800;
            request.ReadWriteTimeout = 800;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                var result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                return result.ContainsKey("app") && (string)result["app"] == "lumos"
                    && result.ContainsKey("root") && String.Equals((string)result["root"], data, StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (WebException) { return false; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    static bool PortUsed()
    {
        using (var client = new TcpClient())
        {
            try { client.Connect("127.0.0.1", 8765); return true; }
            catch (SocketException) { return false; }
        }
    }

    static string Python()
    {
        var candidates = new List<string>();
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string installs = Path.Combine(local, "Programs", "Python");
        if (Directory.Exists(installs))
            foreach (string directory in Directory.GetDirectories(installs, "Python*"))
                candidates.Add(Path.Combine(directory, "python.exe"));
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            @".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"));
        foreach (string executable in candidates)
        {
            if (!File.Exists(executable)) continue;
            var start = new ProcessStartInfo(executable, "-c \"import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            using (var probe = Process.Start(start))
            {
                if (!probe.WaitForExit(5000)) { probe.Kill(); continue; }
                if (probe.ExitCode == 0) return executable;
            }
        }
        throw new InvalidOperationException("未找到 Python 3.12 或更新版本。请安装 Python 后重新打开 Lumos.exe。");
    }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string data = Path.Combine(root, "lumos-data");
            if (!File.Exists(Path.Combine(root, "lumos.py")) || !File.Exists(Path.Combine(data, "lumos.sqlite3")))
                throw new InvalidOperationException("请将 Lumos.exe 放在原 Lumos 仓库根目录中，保留 lumos.py 和 lumos-data 文件夹。");
            string key;
            using (var hash = SHA256.Create())
                key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "");
            using (var mutex = new Mutex(false, "Local\\LumosLauncher-" + key))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) return 0;
                try
                {
                    if (!Ready(data))
                    {
                        if (PortUsed()) throw new InvalidOperationException("8765 端口已被其他服务或旧版看板占用。请先关闭该服务，再打开 Lumos.exe；不会自动结束未知程序。");
                        var start = new ProcessStartInfo(Python(), "\"" + Path.Combine(root, "lumos.py") + "\" --data \"" + data + "\" serve --port 8765");
                        start.WorkingDirectory = root;
                        start.UseShellExecute = false;
                        start.CreateNoWindow = true;
                        using (var server = Process.Start(start))
                        {
                            var timer = Stopwatch.StartNew();
                            while (!Ready(data))
                            {
                                if (server.HasExited) throw new InvalidOperationException("看板启动失败。请在项目对话中检查数据状态和 Python 环境。");
                                if (timer.ElapsedMilliseconds > 15000) throw new InvalidOperationException("看板启动等待超时。请稍后重试，或在项目对话中检查服务状态。");
                                Thread.Sleep(250);
                            }
                        }
                    }
                    // Test mode checks the real launch/reuse path without opening a browser.
                    if (Array.IndexOf(args, "--check") < 0)
                        Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
                    return 0;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            if (Array.IndexOf(args, "--check") < 0)
                MessageBox.Show(error.Message, "Lumos 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
