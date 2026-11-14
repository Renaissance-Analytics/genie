import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePrivateCredential, restrictPrivateFile, useAclHelper, windowsHelper, writePrivateCredential } from '../src/main/private-credentials.js';
import { makePrivate, PRIVATE_FILE, writeJsonAtomic, writeTextPrivate } from '../src/main/store.js';
import { WindowsHelper, helperSpawnArgs } from '../src/main/windows-helper.js';

/**
 * THE REAL THING, ON WINDOWS (Windows CI and genie-test-windows). Launches per write are 0 after the first, the ACL it leaves is read for real, and when the helper fails, the verification is not
 * skipped. A test on the owner's machine it is not: these run only where CI and the VM run them.
 */
const WIDE = 180_000;
const roots: string[] = [];
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), 'windows-helper-')); roots.push(root); return root; };
const windowsPowerShell = (script: string) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const sid = () => windowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
/** Owner, protection and rules, read by something the product did not write. */
const aclOf = (path: string) => JSON.parse(windowsPowerShell(`$p='${path}'; $a=if ([IO.Directory]::Exists($p)) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }; @{ owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$a.AreAccessRulesProtected; rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress`)) as { owner: string; protected: boolean; rules: string | string[] };
const ownerOnly = (path: string) => { const acl = aclOf(path); expect(acl).toMatchObject({ owner: sid(), protected: true }); expect([acl.rules].flat()).toEqual([sid()]); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterEach(async () => {
    useAclHelper(undefined);
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

// CI: WINDOWS ONLY (the Windows helper's own executable)
describe.skipIf(process.platform !== 'win32')('the helper on Windows', () => {
    function counted() {
        let launches = 0;
        const children: { pid?: number | undefined; kill(): boolean }[] = [];
        const helper = new WindowsHelper({
            spawn: (file, args, env) => { launches += 1; const child = spawn(file, [...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] }); children.push(child); return child; },
        });
        useAclHelper(helper);
        return { helper, children, launches: () => launches };
    }

    it('launches per write are 0 after the first, and each write leaves an owner-only file', async () => {
        const root = await fixture();
        const r = counted();
        const file = join(root, 'vault', 'agents.json');
        for (let n = 0; n < 5; n += 1) await writePrivateCredential(file, `{"n":${n}}`);
        expect(r.launches()).toBe(1);
        expect(await readFile(file, 'utf8')).toBe('{"n":4}');
        ownerOnly(file);
        ownerOnly(join(root, 'vault'));
        r.helper.stop();
    }, WIDE);

    it('a foreign grant goes through it, as it does with a launch', async () => {
        const root = await fixture();
        const r = counted();
        const file = join(root, 'vault', 'agents.json');
        await writePrivateCredential(file, '{}');
        execFileSync('icacls', [file, '/grant', '*S-1-5-32-545:R', '/q'], { windowsHide: true });
        await preparePrivateCredential(file);
        ownerOnly(file);
        r.helper.stop();
    }, WIDE);

    it('KILLED MID-WRITE: the write still happens with the full verification, by a launch of its own', async () => {
        const root = await fixture();
        const r = counted();
        const file = join(root, 'vault', 'agents.json');
        await writePrivateCredential(file, '{"before":1}');
        const writing = writePrivateCredential(file, '{"after":1}');
        spawnSync('taskkill', ['/PID', String(r.children[0]!.pid), '/F'], { windowsHide: true });
        await writing;
        expect(await readFile(file, 'utf8')).toBe('{"after":1}');
        ownerOnly(file);
        expect((await readdir(join(root, 'vault'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
        r.helper.stop();
    }, WIDE);

    it('HUNG PAST THE DEADLINE: the helper is ended, nothing is left of it, and a request says it was lost', async () => {
        const helper = windowsHelper({ deadlineMs: 2_000 });
        const request = helper.run('Start-Sleep -Seconds 60');
        await expect(request.completed).rejects.toMatchObject({ name: 'HelperLost' });
        await expect.poll(() => (helper.pid === null ? false : alive(helper.pid)), { timeout: 20_000 }).toBe(false);
    }, WIDE);

    it('GARBAGE: a request it cannot read says so, and it lives', async () => {
        const helper = windowsHelper();
        const bad = helper.run('this is { not a script');
        await expect(bad.completed).rejects.toMatchObject({ code: 1 });
        await helper.run('$null').completed;
        helper.stop();
    }, WIDE);

    it('IT CANNOT OUTLIVE ITS OWNER: killed outright, idle or busy, the helper goes too', async () => {
        const root = await fixture();
        for (const request of [null, 'Start-Sleep -Seconds 45']) {
            const ownerFile = join(root, 'owner.cjs');
            const { file, args } = helperSpawnArgs();
            await writeFile(ownerFile, `
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(file)}, ${JSON.stringify(args)}, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
child.stdout.once('data', () => { ${request ? `child.stdin.write('1 ${Buffer.from(request, 'utf16le').toString('base64')}\\n');` : ''} console.log(child.pid); });
setInterval(() => {}, 1000);
`);
            const owner = spawn(process.execPath, [ownerFile], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
            let said = '';
            owner.stdout.on('data', (d) => { said += d; });
            await expect.poll(() => /\d+/.test(said), { timeout: 60_000 }).toBe(true);
            const pid = Number(/\d+/.exec(said)![0]);
            expect(alive(pid), 'CONTROL: the helper was running').toBe(true);
            owner.kill('SIGKILL');
            await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
        }
    }, WIDE);

    it('the private JSON files: owner-only through the whole write, and no temp file left', async () => {
        const root = await fixture();
        const r = counted();
        const file = join(root, 'runtime', 'services.json');
        await mkdir(join(root, 'runtime'));
        await writeJsonAtomic(file, { password: 'x' }, PRIVATE_FILE);
        ownerOnly(file);
        await writeJsonAtomic(file, { password: 'y' }, PRIVATE_FILE);
        ownerOnly(file);
        expect(r.launches()).toBe(1);
        expect((await readdir(join(root, 'runtime'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
        r.helper.stop();
    }, WIDE);

    it('a file an older Genie left open is tightened when its store opens; one that is not there is fine', async () => {
        const root = await fixture();
        const r = counted();
        const file = join(root, 'remote-devices.json');
        await writeFile(file, '{}');
        expect([aclOf(file).rules].flat().length, 'CONTROL: it starts with inherited grants').toBeGreaterThan(1);
        await makePrivate(file);
        ownerOnly(file);
        await makePrivate(join(root, 'not-there.json'));
        r.helper.stop();
    }, WIDE);

    it('a plain token file goes through the same path, and is whole when it appears', async () => {
        const root = await fixture();
        const r = counted();
        const file = join(root, 'host.token');
        await writeTextPrivate(file, 'a-token');
        expect(await readFile(file, 'utf8')).toBe('a-token');
        ownerOnly(file);
        expect(r.launches()).toBe(1);
        r.helper.stop();
    }, WIDE);

    it('a file that is not there cannot be restricted, and that is a refusal', async () => {
        const root = await fixture();
        await expect(restrictPrivateFile(join(root, 'nope.json'))).rejects.toThrow();
    }, WIDE);
});
