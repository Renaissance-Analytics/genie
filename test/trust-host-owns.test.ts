import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitTreeStatus } from '../src/main/git-ports.js';
import { gitMayRun, setGitReadPolicy } from '../src/main/git-read-policy.js';
import { hostingRig, type HostingRig } from './helpers/hosting-rig.js';

/*
 * THE HOST OWNS TRUST (genie#1519 in the host split). The record and the verdicts are genie-host's, beside its hosting, and
 * genie-host's own git reads follow them (hosting-trust.ts sets its git read policy). Since 2g-4d E2b (Tynn #955) no window
 * holds a copy of the verdicts: the person's Trust and Untrust reach genie-host over the protocol (features.act
 * workspace.trust/untrust, features-host-workspace-config-720.test.ts), and a window's features carry the trust steps. The
 * open-a-repo fix must not get weaker:
 *
 * 1. FAIL CLOSED: before the person's yes, genie-host's git reads in the workspace and Genie's writes into it are refused,
 *    and the window's features show the workspace's trust step. Allowed after the yes, and the step goes.
 * 2. A REVOCATION holds before anything else runs: the host's record first, and its very next git read is refused.
 *
 * The workspace is a real git repository whose own config names a program git would run (core.fsmonitor), so "git ran"
 * is a file the program writes. Every refusal has a control in the same file where git, or the write, went ahead.
 */

let r: HostingRig;
let mark: string;
let tool: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: r.ws, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

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
    await r.close();
    setGitReadPolicy(null);
});

/** The workspaces a window's features show a trust step for (features.snapshot, genie-host's HostFeatures). */
const stepsShown = async () => ((await (await r.features()).snapshot()).trust ?? []).map((s) => s.workspaceId);

describe('1. genie-host fails closed', () => {
    it('before the person’s yes: its git reads in the workspace and Genie’s writes into it are refused, and the window is shown the step', async () => {
        expect(r.stack.trust.isTrustedPath(r.ws)).toBe(false);
        expect(await r.stack.trust.mayWriteInto(r.ws)).toBe(false);
        expect(await gitMayRun(r.ws)).toBe(false);
        await gitTreeStatus(r.ws);
        expect(existsSync(mark)).toBe(false);
        expect(await stepsShown()).toEqual(['ws']);
    });

    it('CONTROL: after the person’s Trust, the same reads and writes go ahead, and the step leaves the window’s features', async () => {
        expect(await r.stack.trust.trust('ws')).toMatchObject({ trusted: true });
        expect(r.stack.trust.isTrustedPath(r.ws)).toBe(true);
        expect(await r.stack.trust.mayWriteInto(r.ws)).toBe(true);
        expect(await gitMayRun(r.ws)).toBe(true);
        await gitTreeStatus(r.ws);
        expect(existsSync(mark)).toBe(true);
        expect(await stepsShown()).toEqual([]);
    });
});

describe('2. a revocation holds before anything else runs', () => {
    it('the person untrusts it: the host records it, and its very next git read is refused; the window is shown the step again', async () => {
        await r.stack.trust.trust('ws');
        // CONTROL: trusted, and git runs.
        expect(await gitMayRun(r.ws)).toBe(true);
        // A changed key does not end it (Tynn #618: trust is given once and stays).
        git('config', 'core.fsmonitor', `${tool.replace(/\\/g, '/')} --other`);
        expect(await r.stack.trust.refresh('ws')).toMatchObject({ trusted: true, changed: false });
        // Only the person's Untrust does.
        expect(await r.stack.trust.untrust('ws')).toMatchObject({ trusted: false });
        // The host's record moved first, and its git policy reads it: refused at once, with no turn in between.
        expect(r.stack.trust.view('ws')).toMatchObject({ trusted: false });
        expect(r.stack.trust.isTrustedPath(r.ws)).toBe(false);
        expect(await gitMayRun(r.ws)).toBe(false);
        expect(await r.stack.trust.mayWriteInto(r.ws)).toBe(false);
        await gitTreeStatus(r.ws);
        expect(existsSync(mark)).toBe(false);
        expect(await stepsShown()).toEqual(['ws']);
    });
});
