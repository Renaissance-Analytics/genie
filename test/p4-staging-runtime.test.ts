import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { runtimeDir } from '../src/main/paths.js';
import { systemProcessTree, type ProcessInfo } from '../src/core/process-tree.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { composeTracker } from './support/compose-tracker.js';
import { resourceDoor } from './support/local-resource-door.js';
import { StagingPermissionsClient } from '../src/main/staging-permissions.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const pty: PtyPort = { open: () => { throw new Error('this test opens no terminal'); }, write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
async function homeFixture() {
    const home = await mkdtemp(join(tmpdir(), 'genie-p4-staging-home-')), tracker = composeTracker();
    const clients: Array<() => void> = [];
    // Own captures and promise-aware composition cleanup, even when an assertion fails or composition is pending.
    cleanups.push(async () => { for (const close of clients) close(); await tracker.shutdownAll(); await rm(home, { recursive: true, force: true }); });
    const root = join(runtimeDir(home), 'local-staging');
    let accept!: (connection: ServerConnection) => void;
    let scheduledSweep: (() => Promise<void>) | undefined;
    const start = () => {
        const input = { userData: home, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
            remoteTransport: { onConnection: (listener: (connection: ServerConnection) => void) => { accept = listener; return () => {}; } },
            scheduleStagingSweep: (work: () => Promise<void>) => { scheduledSweep = work; return () => { if (scheduledSweep === work) scheduledSweep = undefined; }; } };
        return tracker.compose(input);
    };
    const sweepAfterStartup = async () => { expect(scheduledSweep).toBeTypeOf('function'); const work = scheduledSweep!; scheduledSweep = undefined; await work(); };
    const client = async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: { kind: 'local', label: 'composition fixture', isOwner: true, workspaceId: null, readonly: false } });
        const c = connectRemote(pair.client, { kind: 'local' }, 'composition fixture'); clients.push(() => c.close());
        expect(await c.ready).toEqual({ ok: true }); return c;
    };
    return { home, root, start, client, sweepAfterStartup, hasScheduledSweep: () => !!scheduledSweep };
}
async function areaModule() { const path: string = '../src/main/local-staging-area.js'; return import(path); }
async function heldProcess() {
    // Hosted test VM only: a plain, owned Node child; never a provider, app, process-tree kill or the owner's machine.
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const ended = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await ended; };
    cleanups.unshift(stop);
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('the fixture child exited before ready'))); });
    return { child, stop };
}

describe('7B owned staging at real host composition startup', () => {
    it('two sequential native process reads give this process the identical birth time used by staging', async () => {
        const nativeRead = systemProcessTree.read!.bind(systemProcessTree);
        const first = (await nativeRead())?.find(p => p.pid === process.pid);
        expect(first?.started).toBeGreaterThan(0);
        const second = (await systemProcessTree.read!())?.find(p => p.pid === process.pid);
        expect(second?.started).toBe(first!.started);
        const f = await homeFixture(), module = await areaModule(), area = await module.LocalStagingArea.open(f.home);
        expect(area.directory).toBe(join(f.root, `${process.pid}-${first!.started}`));
        await area.sweep();
        expect((await stat(area.directory)).isDirectory()).toBe(true);
    });
    it('defers removal of stale files until after startup, while preserving other runtime data', async () => {
        const f = await homeFixture(), stale = join(f.root, `${process.pid}-1`); // same pid, DIFFERENT start time
        await mkdir(join(stale, 'old-connection'), { recursive: true });
        await writeFile(join(stale, 'stale.bin'), 'earlier process bytes'); await writeFile(join(stale, 'old-connection', 'unfinished'), 'stale chunk');
        await writeFile(join(f.root, 'unidentified.txt'), 'no proven process owner');
        const sibling = join(runtimeDir(f.home), 'keep-other-runtime.txt'); await writeFile(sibling, 'unrelated runtime data');
        await f.start();
        expect(await readFile(join(stale, 'stale.bin'), 'utf8')).toBe('earlier process bytes');
        await f.sweepAfterStartup();
        await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await readdir(f.root)).filter(name => name !== 'unidentified.txt')).toEqual([]);
        expect(await readFile(join(f.root, 'unidentified.txt'), 'utf8')).toBe('no proven process owner');
        expect(await readFile(sibling, 'utf8')).toBe('unrelated runtime data');
        const c = await f.client(), uploaded = await c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 });
        expect((await readdir(f.root)).filter(name => name !== 'unidentified.txt')).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-[1-9][0-9]*$`))]);
        await c.uploads!.abort(uploaded.id);
    });
    it('creates no staging root at compose; the first real upload creates the verified runtime-owned folder', async () => {
        const f = await homeFixture(); await f.start(); await expect(stat(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
        const c = await f.client(), bytes = Uint8Array.from([2, 4, 6, 8]);
        const uploaded = await c.uploads!.stage({ purpose: 'draft-file', subtype: 'attachment' }, bytes);
        const entries = await readdir(f.root, { recursive: true }); expect(entries.length).toBeGreaterThan(0);
        const files = await Promise.all(entries.map(async name => { const path = join(f.root, String(name)); return (await stat(path)).isFile() ? readFile(path) : null; }));
        expect(files.filter(Boolean)).toHaveLength(1); expect(files.find(Boolean)?.equals(Buffer.from(bytes))).toBe(true);
        expect(await c.uploads!.abort(uploaded.id)).toEqual({ aborted: true });
    });
    it('a repeated open/sweep removes only unowned leftovers and preserves a live connection file', async () => {
        const f = await homeFixture(); await f.start(); const c = await f.client();
        const uploaded = await c.uploads!.stage({ purpose: 'draft-file', subtype: 'attachment' }, new Uint8Array([7, 8, 9]));
        const before = await readdir(f.root, { recursive: true }); expect(before.length).toBeGreaterThan(0);
        const stale = join(f.root, `${process.pid}-1`); await mkdir(stale); await writeFile(join(stale, 'stale-after-start'), 'dead owner');
        const module = await areaModule(), area = await module.LocalStagingArea.open(f.home);
        const again = await module.LocalStagingArea.open(join(f.home, '.')); expect(again).toBe(area);
        await area.sweep(); expect(await readdir(f.root, { recursive: true })).toEqual(before);
        const liveFile = before.find(name => String(name).endsWith(uploaded.id)); expect(liveFile).toBeDefined();
        expect((await readFile(join(f.root, String(liveFile)))).equals(Buffer.from([7, 8, 9]))).toBe(true);
        expect(await c.uploads!.abort(uploaded.id)).toEqual({ aborted: true });
    });
    it('a linked staging root does not block compose, but first use refuses it without changing anything outside', async () => {
        const f = await homeFixture(), outside = join(f.home, 'other-data'); await mkdir(outside); await mkdir(runtimeDir(f.home));
        await writeFile(join(outside, 'keep.txt'), 'keep');
        await symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
        await f.start(); const c = await f.client();
        await expect(c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 })).rejects.toThrow(/staging|root|directory/i);
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    });
    it('a link left inside staging is removed without following it into another folder', async () => {
        const f = await homeFixture(), outside = join(f.home, 'other-data'), stale = join(f.root, `${process.pid}-1`); await mkdir(outside); await mkdir(stale, { recursive: true });
        await writeFile(join(outside, 'keep.txt'), 'keep');
        await symlink(outside, join(stale, 'old-link'), process.platform === 'win32' ? 'junction' : 'dir');
        await f.start(); await f.sweepAfterStartup(); await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    });
    it('preserves another real live process folder at startup/sweep, with a real dead process as the deletion control', async () => {
        const f = await homeFixture(), live = await heldProcess(), dead = await heldProcess();
        const table = await systemProcessTree.read!(); expect(table).not.toBeNull();
        const a = table!.find(p => p.pid === live.child.pid), b = table!.find(p => p.pid === dead.child.pid);
        expect(a?.started).toBeGreaterThan(0); expect(b?.started).toBeGreaterThan(0);
        const liveDir = join(f.root, `${a!.pid}-${a!.started}`), deadDir = join(f.root, `${b!.pid}-${b!.started}`);
        await mkdir(liveDir, { recursive: true }); await mkdir(deadDir);
        await writeFile(join(liveDir, 'keep-live'), 'another serving host'); await writeFile(join(deadDir, 'remove-dead'), 'prior process');
        await dead.stop(); await f.start();
        expect(await readFile(join(deadDir, 'remove-dead'), 'utf8')).toBe('prior process');
        await f.sweepAfterStartup();
        await expect(stat(deadDir)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(join(liveDir, 'keep-live'), 'utf8')).toBe('another serving host');
        const module = await areaModule(), area = await module.LocalStagingArea.open(f.home); await area.sweep();
        expect(await readFile(join(liveDir, 'keep-live'), 'utf8')).toBe('another serving host'); expect(live.child.exitCode).toBeNull();
    });
    it('a failed process read preserves every folder and refuses the sweep visibly', async () => {
        const f = await homeFixture(), module = await areaModule();
        let table: readonly ProcessInfo[] | null = [{ pid: process.pid, ppid: 1, started: 1000, name: 'fixture host' }];
        const area = await module.LocalStagingArea.open(f.home, { readProcesses: async () => table });
        const unknown = join(f.root, '12345-67890'); await mkdir(unknown); await writeFile(join(unknown, 'keep'), 'ownership unknown');
        table = null;
        await expect(area.sweep()).rejects.toThrow(/process|ownership|read/i);
        expect(await readFile(join(unknown, 'keep'), 'utf8')).toBe('ownership unknown');
    });
    it('an uncomposed host has no OS-temp fallback for local writes', async () => {
        const f = await resourceDoor(cleanups, { createLocalUploads: undefined }), c = await f.client();
        await expect(c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 })).rejects.toThrow(/staging|available|configured/i);
    });
    it('the raw upload registry requires an explicit host-owned root', async () => {
        const path: string = '../src/main/local-uploads.js', module = await import(path);
        expect(() => new module.LocalUploads()).toThrow(/root|runtime|directory/i);
    });
    it.skipIf(process.platform === 'win32')('repairs the staging root to owner-only mode and leaves its runtime sibling unchanged', async () => {
        const f = await homeFixture(); await mkdir(f.root, { recursive: true }); await chmod(f.root, 0o755);
        expect((await stat(f.root)).mode & 0o777).toBe(0o755);
        const sibling = join(runtimeDir(f.home), 'sibling'); await writeFile(sibling, 'untouched', { mode: 0o644 });
        const mode = (await stat(sibling)).mode & 0o777; await f.start();
        expect((await stat(f.root)).mode & 0o777).toBe(0o755);
        const c = await f.client(), uploaded = await c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 });
        expect((await stat(f.root)).mode & 0o777).toBe(0o700); expect((await stat(sibling)).mode & 0o777).toBe(mode);
        await c.uploads!.abort(uploaded.id);
    });
    it('shutdown cancels a deferred sweep; the next composition can still perform it', async () => {
        const f = await homeFixture(), stale = join(f.root, `${process.pid}-1`); await mkdir(stale, { recursive: true }); await writeFile(join(stale, 'keep-until-sweep'), 'old bytes');
        const services = await f.start(); expect(f.hasScheduledSweep()).toBe(true); await services.shutdown(); expect(f.hasScheduledSweep()).toBe(false);
        expect(await readFile(join(stale, 'keep-until-sweep'), 'utf8')).toBe('old bytes');
        await f.start(); await f.sweepAfterStartup(); await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.skipIf(process.platform !== 'win32')('Windows compose makes no permission-helper call; first stage verifies directories and even an empty file', async () => {
        const directories = vi.spyOn(StagingPermissionsClient.prototype, 'directories'), file = vi.spyOn(StagingPermissionsClient.prototype, 'file');
        const f = await homeFixture(); await f.start(); expect(directories).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled();
        const c = await f.client(), uploaded = await c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 });
        expect(directories).toHaveBeenCalled(); expect(file).toHaveBeenCalledOnce(); expect((await readdir(f.root, { recursive: true })).some(name => String(name).endsWith(uploaded.id))).toBe(true);
        await c.uploads!.abort(uploaded.id);
    });
    it.skipIf(process.platform !== 'win32')('a denied first-use ACL refuses in words with no staged file; verified retry works on the same connection', async () => {
        const denied = vi.spyOn(StagingPermissionsClient.prototype, 'directories').mockRejectedValue(new Error('synthetic private ACL refusal'));
        const f = await homeFixture(); await f.start(); const c = await f.client();
        await expect(c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 })).rejects.toThrow(/private|ACL|permission|secure/i);
        const entries = await readdir(f.root, { recursive: true });
        expect((await Promise.all(entries.map(name => stat(join(f.root, String(name)))))).filter(entry => entry.isFile())).toHaveLength(0);
        denied.mockRestore(); const uploaded = await c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 });
        expect((await readdir(f.root, { recursive: true })).some(name => String(name).endsWith(uploaded.id))).toBe(true); await c.uploads!.abort(uploaded.id);
    });
    it.skipIf(process.platform !== 'win32')('the real Windows ACL protects the folder and new bytes with only this user, with a broad sibling control', async () => {
        const f = await homeFixture(), broad = join(f.home, 'broad-sibling'); await mkdir(broad); await f.start();
        const c = await f.client(); await c.uploads!.stage({ purpose: 'draft-file', subtype: 'attachment' }, new Uint8Array([37]));
        const paths = await readdir(f.root, { recursive: true }); let file = '';
        for (const name of paths) if ((await stat(join(f.root, String(name)))).isFile()) file = join(f.root, String(name));
        expect(file).not.toBe('');
        const targets = [f.root, file, broad].map(path => `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(path, 'utf16le').toString('base64')}'))`);
        const script = `$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$out=@();foreach($p in @(${targets.join(',')})){$a=Get-Acl -LiteralPath $p;$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$out+=@{protected=$a.AreAccessRulesProtected;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=@($rules|%{@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');full=($_.FileSystemRights -eq 'FullControl')}})}};@{sid=$sid;targets=$out}|ConvertTo-Json -Depth 6 -Compress`;
        const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
        const { stdout } = await promisify(execFile)(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 15_000 });
        const acl = JSON.parse(stdout); expect(acl.targets[0].protected).toBe(true);
        for (const [index, target] of acl.targets.slice(0, 2).entries()) { expect(target.owner, index === 0 ? 'staging root owner' : 'stage file owner').toBe(acl.sid); expect(target.rules).toEqual([{ sid: acl.sid, allow: true, full: true }]); }
        expect(acl.targets[2].rules.some((r: { sid: string }) => r.sid !== acl.sid)).toBe(true);
    });
});
