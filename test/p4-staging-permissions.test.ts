import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalUploads } from '../src/main/local-uploads.js';

async function module() { const path: string = '../src/main/staging-permissions.js'; return import(path); }
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
class FakeWorker extends EventEmitter {
    readonly sent: Array<{ kind: string; id: number; mode: string; paths: string[] }> = [];
    ref = vi.fn(); unref = vi.fn(); terminate = vi.fn(async () => 0);
    postMessage(message: FakeWorker['sent'][number]) { this.sent.push(message); }
    reply(index: number, ok = true) { this.emit('message', { kind: 'staging-acl-result', id: this.sent[index]!.id, ok, helper: { starts: 1, pid: 4242, threadId: 7 } }); }
}
async function rig(deadlineMs = 200) {
    const { StagingPermissionsClient } = await module(), workers: FakeWorker[] = [];
    const client = new StagingPermissionsClient({ start: () => { const w = new FakeWorker(); workers.push(w); return w; }, deadlineMs });
    cleanups.push(() => client.stop()); return { client, workers };
}

it('staging ACL creates one lazy worker and reuses it for three requests without exposing paths in diagnostics', async () => {
    const { client, workers } = await rig(); expect(workers).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
        const pending = client.file(`/host/private-${i}`); expect(workers).toHaveLength(1);
        workers[0]!.reply(i); await pending;
    }
    expect(client.diagnostics()).toMatchObject({ workerStarts: 1, helperStarts: 1, helperPid: 4242, threadId: 7, pending: 0 });
    expect(JSON.stringify(client.diagnostics())).not.toContain('/host');
    expect(workers[0]!.unref).toHaveBeenCalled();
});

it('staging ACL correlates concurrent replies and ignores foreign identifiers', async () => {
    const { client, workers } = await rig();
    let completed = false;
    const a = client.file('/host/a').then(() => { completed = true; }), b = client.directories(['/host/own']);
    workers[0]!.emit('message', { kind: 'staging-acl-result', id: 9999, ok: true });
    workers[0]!.reply(1); await b; expect(completed).toBe(false);
    workers[0]!.reply(0); await a;
});

it('a worker verification refusal rejects the permission request and keeps the next request verifiable', async () => {
    const { client, workers } = await rig(); const refused = client.file('/host/refused');
    workers[0]!.reply(0, false); await expect(refused).rejects.toThrow(/private|permission/i);
    const next = client.file('/host/next'); workers[0]!.reply(1); await next;
    expect(workers).toHaveLength(1);
});

it('a lost staging worker rejects every pending permission call and is recreated on the next call', async () => {
    const { client, workers } = await rig(), a = client.file('/host/a'), b = client.file('/host/b');
    const refused = Promise.all([expect(a).rejects.toThrow(), expect(b).rejects.toThrow()]);
    workers[0]!.emit('error', new Error('fixture worker loss')); await refused;
    const next = client.file('/host/next'); expect(workers).toHaveLength(2); workers[1]!.reply(0); await next;
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
});

it('a hung staging worker has a bounded call, is ended, and a late old reply cannot verify the next file', async () => {
    const { client, workers } = await rig(5);
    await expect(client.file('/host/hung')).rejects.toThrow(/private|permission/i);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    const next = client.file('/host/next'); workers[0]!.reply(0); workers[1]!.reply(0); await next;
});

it('stopping the staging worker refuses pending and future calls instead of reporting verification', async () => {
    const { client, workers } = await rig(), pending = client.file('/host/pending');
    const refused = expect(pending).rejects.toThrow(); await client.stop(); await refused;
    await expect(client.file('/host/later')).rejects.toThrow(); expect(workers).toHaveLength(1);
});

it('staging permission requests have a finite queue and excess work is refused before posting', async () => {
    const { MAX_STAGING_ACL_REQUESTS } = await module(), { client, workers } = await rig();
    const pending = Array.from({ length: MAX_STAGING_ACL_REQUESTS }, () => client.file('/host/queued').catch(() => {}));
    await expect(client.file('/host/excess')).rejects.toThrow(/private|permission|queue/i);
    expect(workers[0]!.sent).toHaveLength(MAX_STAGING_ACL_REQUESTS); await client.stop(); await Promise.all(pending);
});

async function nativeFixture() {
    const root = await mkdtemp(join(tmpdir(), 'genie-staging-worker-')); cleanups.push(() => rm(root, { recursive: true, force: true })); return root;
}
async function acl(path: string) {
    const encoded = Buffer.from(path, 'utf16le').toString('base64');
    const body = `$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')));@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|%{@{sid=$_.IdentityReference.Value;inherited=$_.IsInherited;allow=($_.AccessControlType -eq 'Allow');full=($_.FileSystemRights -eq 'FullControl')}})}|ConvertTo-Json -Depth 5 -Compress`;
    const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    const { stdout } = await promisify(execFile)(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 15_000 });
    const value = JSON.parse(stdout); expect(value.owner).toBe(value.sid); expect(value.protected).toBe(true);
    expect(value.rules).toEqual([{ sid: value.sid, inherited: false, allow: true, full: true }]);
}

describe.skipIf(process.platform !== 'win32')('actual off-thread staging ACL helper', () => {
    it('three files share one real helper, and independent Windows reads prove exact owner/access', async () => {
        const root = await nativeFixture(), { StagingPermissionsClient } = await module(), client = new StagingPermissionsClient();
        cleanups.unshift(() => client.stop());
        await client.directories([root]);
        await expect(client.file(root), 'a native directory is never accepted as a verified file').rejects.toThrow();
        for (let n = 0; n < 3; n++) { const path = join(root, `stage-${n}`), file = await open(path, 'wx+', 0o600); await file.close(); await client.file(path); await acl(path); }
        expect(client.diagnostics()).toMatchObject({ workerStarts: 1, helperStarts: 1, pending: 0 });
        expect(client.diagnostics().threadId).toBeGreaterThan(0);
        expect(client.diagnostics().helperPid).toBeGreaterThan(0);
    });

    it('an actually killed helper is restarted, and the next file still has verified current-user owner/access', async () => {
        const root = await nativeFixture(), { StagingPermissionsClient } = await module(), client = new StagingPermissionsClient();
        cleanups.unshift(() => client.stop()); await client.directories([root]);
        const pid = client.diagnostics().helperPid;
        expect(() => process.kill(pid, 0), 'positive control: the exact owned helper is alive').not.toThrow(); process.kill(pid);
        await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
        const path = join(root, 'after-restart'), file = await open(path, 'wx+', 0o600); await file.close(); await client.file(path); await acl(path);
        expect(client.diagnostics()).toMatchObject({ workerStarts: 1, helperStarts: 2 });
        expect(client.diagnostics().helperPid).not.toBe(pid);
    });

    it('a failed verifier refuses a real stage before content and cleanup leaves no file, then a healthy stage verifies', async () => {
        const root = await nativeFixture(), { stagingPermissionsClient } = await module(), client = stagingPermissionsClient();
        cleanups.unshift(() => client.stop()); const stage = new LocalUploads({ root }); cleanups.unshift(() => stage.dispose());
        vi.spyOn(client, 'file').mockRejectedValueOnce(new Error('fixture native verifier refusal'));
        await expect(stage.begin({ purpose: 'file-write', subtype: 'text', size: 3 })).rejects.toThrow(/refus/);
        expect(await readdir(stage.directory)).toEqual([]); vi.restoreAllMocks();
        const next = await stage.begin({ purpose: 'file-write', subtype: 'text', size: 0 }); await acl(join(stage.directory, next.id)); await stage.abort(next.id);
    });

    it('ending the owned worker also ends its exact helper, with a live-helper positive control', async () => {
        const root = await nativeFixture(), { StagingPermissionsClient } = await module(), client = new StagingPermissionsClient();
        cleanups.unshift(() => client.stop()); await client.directories([root]); const pid = client.diagnostics().helperPid;
        expect(() => process.kill(pid, 0)).not.toThrow(); await client.stop();
        await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    });
});
