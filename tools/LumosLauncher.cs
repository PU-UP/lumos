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

    static void Log(string message)
    {
        try
        {
            var directory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".local");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "launcher-status.log"),
                DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    static Dictionary<string, object> ExpectedRuntime(string root, string python)
    {
        var start = new ProcessStartInfo(python, "-B \"" + Path.Combine(root, "lumos.py") + "\" runtime-info");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        using (var process = Process.Start(start))
        {
            if (!process.WaitForExit(10000)) { process.Kill(); throw new InvalidOperationException("程序版本核对超时。"); }
            if (process.ExitCode != 0) throw new InvalidOperationException("无法核对当前程序版本。");
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(process.StandardOutput.ReadToEnd());
        }
    }

    static Dictionary<string, object> Health()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "api/health");
            request.Proxy = null;
            request.Timeout = 3000;
            request.ReadWriteTimeout = 3000;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
        }
        catch (WebException) { return null; }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    static bool Matches(Dictionary<string, object> result, string data, Dictionary<string, object> expected)
    {
        object value;
        var runtime = result.TryGetValue("runtime", out value) ? value as Dictionary<string, object> : null;
        var worker = result.TryGetValue("worker", out value) ? value as Dictionary<string, object> : null;
        return result.ContainsKey("app") && (string)result["app"] == "lumos"
            && result.ContainsKey("root") && String.Equals((string)result["root"], data, StringComparison.OrdinalIgnoreCase)
            && runtime != null && runtime.ContainsKey("code") && Object.Equals(runtime["code"], expected["code"])
            && runtime.ContainsKey("schema") && Object.Equals(runtime["schema"], expected["schema"])
            && result.ContainsKey("data_schema") && Object.Equals(result["data_schema"], expected["schema"])
            && result.ContainsKey("mode") && Object.Equals(result["mode"], "active")
            && result.ContainsKey("preview") && Object.Equals(result["preview"], false)
            && worker != null && worker.ContainsKey("state") && Object.Equals(worker["state"], "available");
    }

    static bool StopOldService(string root, string python, string data, Dictionary<string, object> expected)
    {
        var health = Health();
        if (health == null) throw new InvalidOperationException("8765 已有监听，但健康检查未返回有效结果。");
        if (Matches(health, data, expected)) return false;
        object value;
        var runtime = health.TryGetValue("runtime", out value) ? value as Dictionary<string, object> : null;
        if (runtime == null || !runtime.ContainsKey("code"))
            throw new InvalidOperationException("8765 未返回 Lumos 的运行版本。请检查端口占用。");
        if (Object.Equals(runtime["code"], expected["code"]))
        {
            health.TryGetValue("root", out value);
            if (!String.Equals(value as string, data, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("8765 服务使用了不同的数据目录：" + value);
            health.TryGetValue("data_schema", out value);
            if (!Object.Equals(value, expected["schema"]) || !runtime.ContainsKey("schema") || !Object.Equals(runtime["schema"], value))
                throw new InvalidOperationException("正式服务的数据结构版本不匹配，当前数据版本：" + value);
            health.TryGetValue("worker", out value);
            var worker = value as Dictionary<string, object>;
            if (worker != null && worker.TryGetValue("state", out value) && !Object.Equals(value, "available"))
                throw new InvalidOperationException("后台执行器尚未就绪，当前状态：" + value);
            throw new InvalidOperationException("8765 服务未通过正式工作区身份或启用状态核对。");
        }
        var start = new ProcessStartInfo(python, "-B \"" + Path.Combine(root, "tools", "restart_idle_service.py") + "\"");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.StandardOutputEncoding = Encoding.UTF8;
        using (var process = Process.Start(start))
        {
            string message = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("旧版服务重启检查未通过。" + message);
        }
        return true;
    }

    static bool Ready(string data, Dictionary<string, object> expected)
    {
        var health = Health();
        return health != null && Matches(health, data, expected);
    }

    static bool PortUsed()
    {
        using (var client = new TcpClient())
        {
            try { client.Connect("127.0.0.1", 8765); return true; }
            catch (SocketException error)
            {
                if (error.SocketErrorCode == SocketError.ConnectionRefused) return false;
                throw new InvalidOperationException("无法核对本机 8765 端口：" + error.Message, error);
            }
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
            string python = Python();
            var expected = ExpectedRuntime(root, python);
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
                    if (!Ready(data, expected) && (!PortUsed() || StopOldService(root, python, data, expected)))
                    {
                        var start = new ProcessStartInfo(python, "-B \"" + Path.Combine(root, "lumos.py") + "\" --data \"" + data + "\" serve --port 8765");
                        start.WorkingDirectory = root;
                        start.UseShellExecute = false;
                        start.CreateNoWindow = true;
                        using (var server = Process.Start(start))
                        {
                            var timer = Stopwatch.StartNew();
                            while (!Ready(data, expected))
                            {
                                if (server.HasExited) throw new InvalidOperationException("看板启动失败。请在项目对话中检查数据状态和 Python 环境。");
                                if (timer.ElapsedMilliseconds > 15000) throw new InvalidOperationException("看板启动等待超时。请稍后重试，或在项目对话中检查服务状态。");
                                Thread.Sleep(250);
                            }
                        }
                    }
                    Log("8765 正式服务已通过启动核对。");
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
            Log(error.Message);
            if (Array.IndexOf(args, "--check") < 0)
                MessageBox.Show(error.Message, "Lumos 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
