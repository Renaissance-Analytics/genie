import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';

const TSX = import.meta.resolve('tsx');

/*
 * THE HOST'S PIPE ANSWERS ITS OWN USER ONLY (Tynn #398). On Windows genie-host serves windows on a named pipe. Node
 * creates it with Windows' default security descriptor, which grants other accounts access too (Administrators, and
 * read access for Everyone and anonymous). The host now gives its pipe an explicit, protected DACL: the user it runs
 * as, and SYSTEM, nothing else. The token hello stays the second gate.
 *
 * Read from the LIVE pipe of a real genie-host, by a reader of its own (GetSecurityInfo on a handle it opens with READ_CONTROL, as SDDL), never by the
 * code that sets it. CONTROL: the same reader, on a pipe Node made with the default, finds an account beyond those two.
 */
const READER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PipeSd {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool WaitNamedPipeW(string name, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(IntPtr handle, int type, int info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint revision, int info, out IntPtr text, out uint length);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr p);
    public static string Read(string name) {
        IntPtr h = new IntPtr(-1);
        for (int i = 0; i < 40; i++) {
            // READ_CONTROL only (0x00020000); OPEN_EXISTING (3). A pipe whose instances are all taken answers busy (231).
            h = CreateFileW(name, 0x00020000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (h != new IntPtr(-1)) break;
            int e = Marshal.GetLastWin32Error();
            if (e != 231) throw new Win32Exception(e);
            WaitNamedPipeW(name, 250);
        }
        if (h == new IntPtr(-1)) throw new Win32Exception(231);
        IntPtr owner, group, dacl, sacl, sd;
        // SE_KERNEL_OBJECT (6); OWNER (1) | DACL (4).
        uint error = GetSecurityInfo(h, 6, 5, out owner, out group, out dacl, out sacl, out sd);
        CloseHandle(h);
        if (error != 0) throw new Win32Exception((int)error);
        IntPtr text; uint length;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 5, out text, out length)) throw new Win32Exception();
        string sddl = Marshal.PtrToStringUni(text);
        LocalFree(text); LocalFree(sd);
        return sddl;
    }
}
'@
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Write-Output ("USER " + $user)
Write-Output ("SDDL " + [PipeSd]::Read($args[0]))
`;

let dir: string;
let reader: string;

/** The pipe's owner and DACL as SDDL, and the SID of the user this test runs as. */
async function readPipe(pipe: string): Promise<{ user: string; sddl: string }> {
    const powershell = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const out = await new Promise<string>((done, fail) => execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', reader, pipe], { encoding: 'utf8', timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => (error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout))));
    const user = /^USER (\S+)/m.exec(out)?.[1];
    const sddl = /^SDDL (\S+)/m.exec(out)?.[1];
    if (!user || !sddl) throw new Error(`the reader printed no USER/SDDL line: ${out}`);
    return { user, sddl };
}

/** The DACL part of an SDDL string: its flags and each ACE as [type, rights, sid]. */
function daclOf(sddl: string): { flags: string; aces: { type: string; rights: string; sid: string }[] } {
    const d = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
    if (!d) return { flags: '', aces: [] };
    const aces = [...d[2]!.matchAll(/\(([^)]*)\)/g)].map((m) => { const f = m[1]!.split(';'); return { type: f[0]!, rights: f[2]!, sid: f[5]! }; });
    return { flags: d[1]!, aces };
}

describe.skipIf(process.platform !== 'win32')('the host pipe answers its own user only (Windows)', () => {
    let home: string;
    let host: ChildProcess;
    let log = '';
    let record: HostRecord;
    let plain: Server;
    const plainPipe = `\\\\.\\pipe\\genie-acl-control-${process.pid}`;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'host-pipe-acl-'));
        reader = join(dir, 'pipe-sddl.ps1');
        await writeFile(reader, READER, 'utf8');
        plain = createServer((s) => s.destroy());
        await new Promise<void>((r) => plain.listen(plainPipe, r));

        home = join(dir, 'home');
        await mkdir(join(home, 'runtime'), { recursive: true });
        host = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
            env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'pipe-acl-test', GENIE_HOST_IDLE_MS: '600000', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        host.stdout?.on('data', (d) => { log += String(d); });
        host.stderr?.on('data', (d) => { log += String(d); });
        const deadline = Date.now() + 120_000;
        for (;;) {
            const r = parseHostRecord(await readFile(join(home, 'runtime', 'host.json'), 'utf8').catch(() => null));
            if (r && r.pid === host.pid) { record = r; break; }
            if (Date.now() > deadline) throw new Error(`no host.json\n--- host log ---\n${log}`);
            await new Promise((s) => setTimeout(s, 100));
        }
    }, 180_000);

    afterAll(async () => {
        if (host && host.exitCode === null) host.kill('SIGKILL');
        await new Promise<void>((r) => (plain ? plain.close(() => r()) : r()));
        await new Promise((s) => setTimeout(s, 500));
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it('CONTROL: a pipe Node made with the default grants an account beyond the user and SYSTEM (the reader sees it)', async () => {
        const { user, sddl } = await readPipe(plainPipe);
        const others = daclOf(sddl).aces.filter((a) => a.sid !== user && a.sid !== 'SY');
        expect(others.length, sddl).toBeGreaterThan(0);
    }, 90_000);

    it('the live host pipe: a protected DACL that allows the user and SYSTEM, and no one else', async () => {
        const { user, sddl } = await readPipe(record.endpoint);
        const dacl = daclOf(sddl);
        expect(dacl.flags, sddl).toContain('P');
        expect(dacl.aces.map((a) => a.type), sddl).toEqual(dacl.aces.map(() => 'A'));
        expect(new Set(dacl.aces.map((a) => a.sid)), sddl).toEqual(new Set([user, 'SY']));
        expect(sddl, 'no Everyone, anonymous or Administrators entry').not.toMatch(/;;;(WD|AN|BA|BU|AU)\)/);
    }, 90_000);

    it('stays so after more connections than the pipe keeps instances for (a new instance is not given the default)', async () => {
        for (let i = 0; i < 8; i += 1) {
            await new Promise<void>((done, fail) => { const s = connect(record.endpoint); s.once('connect', () => { s.destroy(); done(); }); s.once('error', fail); });
        }
        const { user, sddl } = await readPipe(record.endpoint);
        expect(new Set(daclOf(sddl).aces.map((a) => a.sid)), sddl).toEqual(new Set([user, 'SY']));
    }, 90_000);
});
