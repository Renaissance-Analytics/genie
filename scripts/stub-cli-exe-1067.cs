// A WINDOWS .EXE FOR THE STUB CLAUDE CODE (Tynn #1067's drain row). Genie runs a native Claude Code by its own path and
// updates it with `<program> update` only when that program is an .exe (core/cli-repair.ts planCliUpdate), so on Windows
// the stub must be one. Built on the test VM with the .NET Framework's own csc.exe; it runs
// `node stub-claude-cli-1067.mjs <args>` from its own folder (node-path.txt beside it names node), its streams relayed both ways and
// flushed at once (the session protocol is line by line), and exits with the stub's exit code.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

class StubCli {
    static string Quote(string s) {
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in s) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
            sb.Append('\\', slashes); slashes = 0; sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static void Pump(Stream from, Stream to, bool closeTo) {
        var buffer = new byte[65536];
        try {
            int n;
            while ((n = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, n); to.Flush(); }
        } catch (Exception) { }
        if (closeTo) { try { to.Close(); } catch (Exception) { } }
    }

    static int Main(string[] args) {
        // node's path BESIDE THIS .EXE (node-path.txt), never an environment variable: a session's is filtered.
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string pathFile = Path.Combine(dir, "node-path.txt");
        string node = File.Exists(pathFile) ? File.ReadAllText(pathFile).Trim() : "node.exe";
        var line = new StringBuilder(Quote(Path.Combine(dir, "stub-claude-cli-1067.mjs")));
        foreach (var a in args) { line.Append(' '); line.Append(Quote(a)); }
        var psi = new ProcessStartInfo(node, line.ToString()) {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        var p = Process.Start(psi);
        var output = new Thread(() => Pump(p.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
        var error = new Thread(() => Pump(p.StandardError.BaseStream, Console.OpenStandardError(), false));
        var input = new Thread(() => Pump(Console.OpenStandardInput(), p.StandardInput.BaseStream, true)) { IsBackground = true };
        output.Start(); error.Start(); input.Start();
        p.WaitForExit();
        output.Join(); error.Join();
        return p.ExitCode;
    }
}
