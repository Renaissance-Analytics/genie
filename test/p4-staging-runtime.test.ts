import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { runtimeDir } from '../src/main/paths.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { composeTracker } from './support/compose-tracker.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const pty: PtyPort = { open: () => { throw new Error('this test opens no terminal'); }, write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
async function homeFixture() {
    const home = await mkdtemp(join(tmpdir(), 'genie-p4-staging-home-')), tracker = composeTracker();
    const clients: Array<() => void> = [];
    // Own captures and promise-aware composition cleanup, even when an assertion fails or composition is pending.
    cleanups.push(async () => { for (const close of clients) close(); await tracker.shutdownAll(); await rm(home, { recursive: true, force: true }); });
    const root = join(runtimeDir(home), 'local-staging');
    let accept!: (connection: ServerConnection) => void;
    const start = () => tracker.compose({ userData: home, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, remoteTransport: { onConnection: listener => { accept = listener; return () => {}; } } });
    const client = async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: { kind: 'local', label: 'composition fixture', isOwner: true, workspaceId: null, readonly: false } });
        const c = connectRemote(pair.client, { kind: 'local' }, 'composition fixture'); clients.push(() => c.close());
        expect(await c.ready).toEqual({ ok: true }); return c;
    };
    return { home, root, start, client };
}
async function areaModule() { const path: string = '../src/main/local-staging-area.js'; return import(path); }

describe('7B owned staging at real host composition startup', () => {
    it('removes stale files and nested connection folders at start, while preserving other runtime data', async () => {
        const f = await homeFixture(); await mkdir(join(f.root, 'old-connection'), { recursive: true });
        await writeFile(join(f.root, 'stale.bin'), 'earlier process bytes'); await writeFile(join(f.root, 'old-connection', 'unfinished'), 'stale chunk');
        const sibling = join(runtimeDir(f.home), 'keep-other-runtime.txt'); await writeFile(sibling, 'unrelated runtime data');
        await f.start();
        expect(await readdir(f.root)).toEqual([]); expect(await readFile(sibling, 'utf8')).toBe('unrelated runtime data');
    });
    it('creates the runtime-owned folder and wires real local uploads into it before accepting calls', async () => {
        const f = await homeFixture(); await f.start(); expect((await stat(f.root)).isDirectory()).toBe(true);
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
        await writeFile(join(f.root, 'stale-after-start'), 'unowned');
        const module = await areaModule(), area = await module.LocalStagingArea.open(f.home);
        const again = await module.LocalStagingArea.open(join(f.home, '.')); expect(again).toBe(area);
        await area.sweep(); expect(await readdir(f.root, { recursive: true })).toEqual(before);
        const liveFile = before.find(name => String(name).endsWith(uploaded.id)); expect(liveFile).toBeDefined();
        expect((await readFile(join(f.root, String(liveFile)))).equals(Buffer.from([7, 8, 9]))).toBe(true);
        expect(await c.uploads!.abort(uploaded.id)).toEqual({ aborted: true });
    });
    it('refuses a linked staging root before deleting or changing anything outside it', async () => {
        const f = await homeFixture(), outside = join(f.home, 'other-data'); await mkdir(outside); await mkdir(runtimeDir(f.home));
        await writeFile(join(outside, 'keep.txt'), 'keep');
        await symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
        await expect(f.start()).rejects.toThrow(); expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    });
    it('a link left inside staging is removed without following it into another folder', async () => {
        const f = await homeFixture(), outside = join(f.home, 'other-data'); await mkdir(outside); await mkdir(f.root, { recursive: true });
        await writeFile(join(outside, 'keep.txt'), 'keep');
        await symlink(outside, join(f.root, 'old-link'), process.platform === 'win32' ? 'junction' : 'dir');
        await f.start(); expect(await readdir(f.root)).toEqual([]); expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
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
        expect((await stat(f.root)).mode & 0o777).toBe(0o700); expect((await stat(sibling)).mode & 0o777).toBe(mode);
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
        for (const target of acl.targets.slice(0, 2)) { expect(target.owner).toBe(acl.sid); expect(target.rules).toEqual([{ sid: acl.sid, allow: true, full: true }]); }
        expect(acl.targets[2].rules.some((r: { sid: string }) => r.sid !== acl.sid)).toBe(true);
    });
});
