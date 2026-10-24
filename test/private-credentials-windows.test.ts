import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePrivateCredential } from '../src/main/private-credentials.js';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'genie-private-acl-'));
    directories.push(directory);
    return directory;
}
async function windows(script: string): Promise<string[]> {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    const { stdout } = await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { env, windowsHide: true, timeout: 15_000 });
    return stdout.trim().split(/\r?\n/);
}
const dataPath = (path: string) => `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(path, 'utf16le').toString('base64')}'))`;
const readAcl = (path: string, directory: boolean) => windows(`$a=[IO.${directory ? 'Directory' : 'File'}]::GetAccessControl((${dataPath(path)}));'protected='+$a.AreAccessRulesProtected;'owner='+$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|%{$_.IdentityReference.Value+'|'+$_.IsInherited+'|'+$_.AccessControlType+'|'+$_.FileSystemRights}`);

describe.skipIf(process.platform !== 'win32')('native Windows private credential ACL', () => {
    it('removes explicit foreign grants from existing directories and files, including quoted Unicode paths', async () => {
        const root = await fixture(); const directory = join(root, "owner's $(unused) 日本");
        await mkdir(directory); const file = join(directory, 'credentials.json'); await writeFile(file, 'encrypted fixture');
        const [sid] = await windows('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
        expect(sid).toMatch(/^S-\d+(?:-\d+)+$/);
        const otherSid = sid!.replace(/-\d+$/, '-500'); expect(otherSid).not.toBe(sid);
        const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
        for (const foreign of ['S-1-1-0', otherSid]) {
            await execute(system, [directory, '/grant', `*${foreign}:(OI)(CI)RX`], { windowsHide: true });
            await execute(system, [file, '/grant', `*${foreign}:RX`], { windowsHide: true });
            expect(await readAcl(directory, true)).toContain(`${foreign}|False|Allow|ReadAndExecute, Synchronize`);
            expect(await readAcl(file, false)).toContain(`${foreign}|False|Allow|ReadAndExecute, Synchronize`);
        }
        await preparePrivateCredential(file);
        const exact = ['protected=True', `owner=${sid}`, `${sid}|False|Allow|FullControl`];
        expect(await readAcl(directory, true)).toEqual(exact);
        expect(await readAcl(file, false)).toEqual(exact);
        expect(await readFile(file, 'utf8')).toBe('encrypted fixture');
    });

    it('removes a new empty leaf after restriction failure and preserves an existing directory and file', async () => {
        const root = await fixture(); const existing = join(root, 'existing'); await mkdir(existing);
        const file = join(existing, 'credentials.json'); await writeFile(file, 'existing encrypted fixture');
        const before = await readAcl(existing, true);
        const savedRoot = process.env.SystemRoot;
        try {
            process.env.SystemRoot = join(root, 'missing-system-root');
            const fresh = join(root, 'fresh');
            await expect(preparePrivateCredential(join(fresh, 'credentials.json'))).rejects.toThrow('Private Tynn credential permissions could not be secured.');
            await expect(readFile(join(fresh, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(preparePrivateCredential(file)).rejects.toThrow('Private Tynn credential permissions could not be secured.');
        } finally {
            if (savedRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = savedRoot;
        }
        expect(await readFile(file, 'utf8')).toBe('existing encrypted fixture');
        expect(await readAcl(existing, true)).toEqual(before);
    });
});
