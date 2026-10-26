import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePrivateCredential } from '../src/main/private-credentials.js';
import { TynnAccount } from '../src/main/tynn-account.js';
import { tynnAgentIdentities } from '../src/main/tynn-agent-identities.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';

const execute = promisify(execFile);
// Native ACL calls have a60s bound; allow two slow calls plus setup/ACL verification in these cases.
const NATIVE_CASE_TIMEOUT_MS = 180_000;
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
const readAclSet = (targets: readonly { path: string; directory: boolean }[]) => windows(`$i=0;foreach($t in @(${targets.map(target => `@{Path=(${dataPath(target.path)});Directory=$${target.directory}}`).join(',')})){'target='+$i;$a=if($t.Directory){[IO.Directory]::GetAccessControl($t.Path)}else{[IO.File]::GetAccessControl($t.Path)};'protected='+$a.AreAccessRulesProtected;'owner='+$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|%{$_.IdentityReference.Value+'|'+$_.IsInherited+'|'+$_.AccessControlType+'|'+$_.FileSystemRights};$i++}`);

describe.skipIf(process.platform !== 'win32')('native Windows private credential ACL', () => {
    it('refuses a directory containing unrelated siblings without changing any ACL', async () => {
        const directory = await fixture(); const file = join(directory, 'credential.json'); const sibling = join(directory, 'runtime.dll');
        await writeFile(file, 'encrypted fixture'); await writeFile(sibling, 'unrelated runtime');
        const paths = [{ path: directory, directory: true }, { path: file, directory: false }, { path: sibling, directory: false }];
        const before = await readAclSet(paths);
        expect(before.slice(0, before.indexOf('target=1')).some(rule => rule.includes('|True|Allow|'))).toBe(true);
        const error = await preparePrivateCredential(file).then(() => null, (caught: unknown) => caught);
        expect(await readAclSet(paths), 'occupied directory ACL remains unchanged').toEqual(before);
        expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain('unrelated entries');
        expect(await readFile(sibling, 'utf8')).toBe('unrelated runtime');
    }, NATIVE_CASE_TIMEOUT_MS);

    it('migrates the pairing file and restricts both vaults without changing the home or sibling ACL', async () => {
        const home = await fixture(); const legacyFile = join(home, 'tynn.json');
        const file = join(home, 'credentials', 'tynn.json'); const sibling = join(home, 'runtime-fixture');
        await writeFile(sibling, 'unrelated runtime');
        const shared = [{ path: home, directory: true }, { path: sibling, directory: false }];
        const sharedBefore = await readAclSet(shared);
        expect(sharedBefore.slice(0, sharedBefore.indexOf('target=1')).some(rule => rule.includes('|True|Allow|'))).toBe(true);
        const token = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'a'.repeat(64)}`;
        const scopes = ['discovery', 'projects', 'workstations', 'agents', 'agent-tokens', 'issue-watch', 'issues', 'inbox'].map(scope => `genie:${scope}`);
        const original = JSON.stringify({ version: 1, state: 'signed-in', host: 'https://fixture.invalid', userId: 'fixture-user', scopes, tokenEnc: Buffer.from(`fixture:${token}`).toString('base64') });
        await writeFile(legacyFile, original);
        let requests = 0;
        const cipher = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(`fixture:${text}`), decrypt: (bytes: Buffer) => bytes.toString().slice('fixture:'.length) };
        const ports = { file, legacyFile, cipher, host: () => 'https://fixture.invalid',
            cookies: { clear: async () => {}, get: async () => null, set: async () => {} },
            fetch: async (_url: string, init: { headers: Record<string, string> }) => {
                requests++; expect(init.headers.Authorization).toBe(`Bearer ${token}`);
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'fixture-user', name: 'Fixture', email: 'fixture@example.invalid' }) };
            },
        };
        const account = await TynnAccount.open(ports);
        expect(await readAclSet(shared), 'pairing migration preserves shared home ACL').toEqual(sharedBefore);
        expect(account.status().signedIn).toBe(true); expect(requests).toBe(1);
        await expect(stat(legacyFile)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(file, 'utf8')).toBe(original);
        const identityDirectory = join(home, 'agent-credentials'); await mkdir(identityDirectory);
        const identities = join(identityDirectory, 'agents.json'); await writeFile(identities, JSON.stringify({ version: 1, records: {} }));
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'fixture', name: 'fixture-agent', provider: 'codex', mode: 'automated', instructions: null });
        const result = await tynnAgentIdentities({ file: identities, cipher }).ensure({ projectId: 'fixture-project', agent,
            tynn: { status: () => ({ signedIn: true as const, host: 'https://fixture.invalid', user: { name: 'Fixture', email: 'fixture@example.invalid' } }), userId: () => 'fixture-user',
                request: async () => { requests++; return { ok: false, status: 503, json: async () => ({}) }; } },
        });
        expect(result).toMatchObject({ status: 'failed', code: 'offline' }); expect(requests).toBe(2);
        expect(await readAclSet(shared), 'identity vault preserves shared home ACL').toEqual(sharedBefore);
        const [sid] = await windows('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
        const exact = ['protected=True', `owner=${sid}`, `${sid}|False|Allow|FullControl`];
        const privatePaths = [{ path: join(home, 'credentials'), directory: true }, { path: identityDirectory, directory: true }, { path: file, directory: false }, { path: identities, directory: false }];
        expect(await readAclSet(privatePaths)).toEqual(privatePaths.flatMap((_path, index) => [`target=${index}`, ...exact]));
    }, NATIVE_CASE_TIMEOUT_MS);

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
    }, NATIVE_CASE_TIMEOUT_MS);

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
    }, NATIVE_CASE_TIMEOUT_MS);
});
