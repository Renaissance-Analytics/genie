import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitTreeStatus } from '../src/main/git-ports.js';
import { gitMayRun, setGitReadPolicy, trustAwarePolicy } from '../src/main/git-read-policy.js';
import { HostingReplica } from '../src/main/hosting-host.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/*
 * THE HOST OWNS TRUST (genie#1519 in the host split). The record and the verdicts are genie-host's, beside its hosting; a
 * local window reads them from the hosting dump, and the person's yes is an `engine.hosting` call. The open-a-repo fix
 * must not get weaker in the move:
 *
 * 1. FAIL CLOSED: before the window's first dump, and after its link drops, every workspace reads as untrusted there —
 *    its git reads and Genie's writes (config sync) refused. Allowed after a dump that trusts it.
 * 2. A REVOCATION reaches the window before anything else runs: the host's record first, then the push, at once.
 * 3. The trust action is a LOCAL window's only: a remote or genie-cloud link cannot trust a workspace.
 *
 * The workspace is a real git repository whose own config names a program git would run (core.fsmonitor), so "git ran"
 * is a file the program writes. Every refusal has a control in the same file where git, or the write, went ahead.
 */

let r: HostingRig;
let mark: string;
let tool: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: r.ws, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
/** The window's own git policy, as compose sets it over the hosting replica. */
const windowPolicy = (replica: HostingReplica) => setGitReadPolicy(trustAwarePolicy((path) => replica.trust.isTrustedPath(path)));

beforeEach(async () => {
    // A home whose record carries nothing: the workspace came after the upgrade, so it is not trusted until the person says so.
    const home = mkdtempSync(join(tmpdir(), 'trust-host-home-'));
    mkdirSync(join(home, 'runtime'), { recursive: true });
    writeFileSync(join(home, 'runtime', 'workspace-trust.json'), JSON.stringify({ version: 1, carried: [], pendingCarry: [], sites: {}, workspaces: {} }));
    r = await hostingRig({ home });
    mark = join(r.home, 'mark.txt');
    tool = join(r.home, 'tool.sh');
    git('init', '-q');
    writeFileSync(join(r.ws, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(tool, `#!/bin/sh\necho ran > '${mark.replace(/\\/g, '/')}'\nexit 0\n`);
    chmodSync(tool, 0o755);
    git('config', 'core.fsmonitor', tool.replace(/\\/g, '/'));
    expect(await r.stack.trust.refresh('ws')).toMatchObject({ trusted: false });
});

afterEach(async () => {
    setGitReadPolicy(null);
    await r.close();
});

describe('1. the window fails closed', () => {
    it('before its first dump: every workspace untrusted, its git reads and Genie’s writes refused', async () => {
        const replica = new HostingReplica(async () => { throw new Error('no host'); });
        windowPolicy(replica);
        expect(replica.trust.isTrustedPath(r.ws)).toBe(false);
        expect(await replica.trust.mayWriteInto(r.ws)).toBe(false);
        expect(await gitMayRun(r.ws)).toBe(false);
        await gitTreeStatus(r.ws);
        expect(existsSync(mark)).toBe(false);
    });

    it('CONTROL: after a dump that trusts it, the same reads and writes go ahead', async () => {
        const w = await r.window();
        windowPolicy(w.replica);
        expect(await w.replica.trust.mayWriteInto(r.ws)).toBe(false);
        expect(await w.replica.trust.trust('ws')).toMatchObject({ trusted: true });
        expect(w.replica.trust.isTrustedPath(r.ws)).toBe(true);
        expect(await w.replica.trust.mayWriteInto(r.ws)).toBe(true);
        expect(await gitMayRun(r.ws)).toBe(true);
        await gitTreeStatus(r.ws);
        expect(existsSync(mark)).toBe(true);
        w.close();
    });

    it('after its link drops: the verdict it last heard is not believed, so a trusted workspace reads as untrusted again', async () => {
        const w = await r.window();
        windowPolicy(w.replica);
        await w.replica.trust.trust('ws');
        expect(await w.replica.trust.mayWriteInto(r.ws)).toBe(true);
        w.close();
        await tick();
        expect(w.replica.trust.isTrustedPath(r.ws)).toBe(false);
        expect(await w.replica.trust.mayWriteInto(r.ws)).toBe(false);
        expect(await gitMayRun(r.ws)).toBe(false);
        await gitTreeStatus(r.ws);
        expect(existsSync(mark)).toBe(false);
        // The host's own record is untouched: the window stopped believing it, nothing revoked it.
        expect(r.stack.trust.view('ws')).toMatchObject({ trusted: true });
    });
});

describe('2. a revocation reaches the window before anything else runs', () => {
    it('the key changes: the host records it, pushes at once, and the window’s next git read is refused', async () => {
        const w = await r.window();
        windowPolicy(w.replica);
        await w.replica.trust.trust('ws');
        // CONTROL: trusted, and git runs.
        expect(await gitMayRun(r.ws)).toBe(true);
        git('config', 'core.fsmonitor', `${tool.replace(/\\/g, '/')} --other`);
        expect(await r.stack.trust.refresh('ws')).toMatchObject({ trusted: false, changed: true });
        // The host's record moved first; one turn of the link later (well inside any coalescing), the window has it.
        expect(r.stack.trust.view('ws')).toMatchObject({ trusted: false });
        await tick(1);
        expect(w.replica.trust.isTrustedPath(r.ws)).toBe(false);
        expect(await w.replica.trust.mayWriteInto(r.ws)).toBe(false);
        expect(await gitMayRun(r.ws)).toBe(false);
        await gitTreeStatus(r.ws);
        expect(existsSync(mark)).toBe(false);
        w.close();
    });
});

describe('3. only a local window can trust a workspace', () => {
    it('a remote or genie-cloud link (not the host’s own endpoint) is refused, and the workspace stays untrusted', async () => {
        const remote = await r.window({ local: false });
        const asked = await remote.client.call('engine.hosting', ['trust.trust', ['ws']]);
        expect(asked).toMatchObject({ ok: false });
        expect(r.stack.trust.view('ws')).toMatchObject({ trusted: false });
        // Nor is it told the verdicts: no dump reaches it.
        expect(remote.replica.trust.entries()).toEqual([]);
        remote.close();
        // CONTROL: the same call from a local window is the person's yes.
        const local = await r.window();
        expect(await local.client.call('engine.hosting', ['trust.trust', ['ws']])).toMatchObject({ ok: true });
        expect(r.stack.trust.view('ws')).toMatchObject({ trusted: true });
        local.close();
    });
});
