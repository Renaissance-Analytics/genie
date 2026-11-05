import { ChildProcess, execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalUploads } from '../src/main/local-uploads.js';
import { restrictPrivateDirectories, useAclHelper } from '../src/main/private-credentials.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'genie-stage-windows-cost-'));
    cleanups.push(() => rm(root, { recursive: true, force: true })); return root;
}
async function acls(paths: string[]) {
    const targets = paths.map(path => `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(path, 'utf16le').toString('base64')}'))`);
    const body = `$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$out=@();foreach($p in @(${targets.join(',')})){$a=Get-Acl -LiteralPath $p;$out+=@{protected=$a.AreAccessRulesProtected;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|%{@{sid=$_.IdentityReference.Value;inherited=$_.IsInherited;allow=($_.AccessControlType -eq 'Allow');full=($_.FileSystemRights -eq 'FullControl')}})}};@{sid=$sid;targets=$out}|ConvertTo-Json -Depth 6 -Compress`;
    const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    const { stdout } = await promisify(execFile)(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 15_000 });
    return JSON.parse(stdout);
}

describe.skipIf(process.platform !== 'win32')('native Windows local staging cost and protection', () => {
    it('measures raw Node child-file ownership separately from inherited owner-only access', async () => {
        useAclHelper(null);
        const root = await fixture(), directory = join(root, 'private'), file = join(directory, 'empty-probe');
        await mkdir(directory); await restrictPrivateDirectories([directory]);
        const handle = await open(file, 'wx+', 0o600); await handle.close();
        const result = await acls([directory, file, root]);
        expect(result.targets[0]).toMatchObject({ owner: result.sid, protected: true });
        expect(result.targets[0].rules).toEqual([{ sid: result.sid, inherited: false, allow: true, full: true }]);
        expect(result.targets[1].rules).toEqual([{ sid: result.sid, inherited: true, allow: true, full: true }]);
        expect(result.targets[2].rules.some((rule: { sid: string }) => rule.sid !== result.sid), 'broad parent positive control').toBe(true);
        // A diagnostic of the proposed remedy, not permission to accept a foreign owner.
        console.log('PRIVATE_STAGE_INHERITANCE_PROBE', { ownerMatchesCurrentUser: result.targets[1].owner === result.sid, inheritedOnlyCurrentUser: true });
    });

    it('repeated stages in a prepared private folder launch no per-stage ACL processes and retain exact bytes', async () => {
        useAclHelper(null);
        const root = await fixture(), stage = new LocalUploads({ root });
        cleanups.unshift(() => stage.dispose());
        const first = await stage.begin({ purpose: 'file-write', subtype: 'text', size: 0 });
        await (await stage.take(first.id, 'file-write', 'text'))!.close();
        let launches = 0;
        const prototype = ChildProcess.prototype as unknown as { spawn(options: { file?: string }): unknown };
        const original = prototype.spawn;
        vi.spyOn(prototype, 'spawn').mockImplementation(function (this: unknown, options) {
            if (/(?:^|[\\/])powershell(?:\.exe)?$/i.test(options.file ?? '')) launches++;
            return original.call(this, options);
        });
        for (const text of ['first staged bytes', '雪 after reuse', 'third staged bytes']) {
            const bytes = Buffer.from(text), opened = await stage.begin({ purpose: 'file-write', subtype: 'text', size: bytes.length });
            await stage.chunk(opened.id, 0, bytes.toString('base64'));
            const source = await stage.take(opened.id, 'file-write', 'text');
            expect(Buffer.from(await source!.read(0, bytes.length)).equals(bytes)).toBe(true); await source!.close();
        }
        expect(launches, 'the native ACL work must be verified once for the private folder, outside each save').toBe(0);
        expect(await readdir(stage.directory)).toEqual([]);
    });
});
