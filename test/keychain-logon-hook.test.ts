import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const hookName = 'GenieKeychainAtLogon';
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

// These tests execute PowerShell, not assertions about its source. The harness replaces
// registry/task commands, so a standard user, a refused write, and stale readback are deterministic.
function run(phase: 'logon-install' | 'logon-read', scenario = 'ok', hasResult = false) {
    const root = mkdtempSync(join(tmpdir(), 'genie-logon-'));
    fixtures.push(root);
    const repo = join(root, "repo space & O'Brien");
    const publicDir = join(root, 'public space');
    mkdirSync(repo); mkdirSync(publicDir);
    if (hasResult) writeFileSync(join(publicDir, 'genie-keychain-at-logon.txt'), 'fixture result\n');
    const stateFile = join(root, 'state.json');
    const r = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./fixtures/keychain-logon-harness.ps1', import.meta.url)),
    ], {
        cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, PUBLIC: publicDir, HOOK_SCRIPT: resolve('scripts/perf-lag/keychain-sessions-windows.ps1'), HOOK_PHASE: phase, HOOK_CASE: scenario, HOOK_STATE: stateFile },
    });
    if (r.error) throw r.error;
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        value: string | null; otherValue: string;
        writes: { path: string; name: string; value: string; type: string; force: boolean }[];
        reads: { path: string; name: string }[];
        removals: { path: string; name: string }[]; tasks: string[][];
    };
    return { ...r, state, repo, publicDir };
}

describe('the Windows keychain sign-in hook, through its real phases', () => {
    it('installs and verifies a per-user string value without needing scheduled-task permission', () => {
        const r = run('logon-install');
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain('logon-install=PASS');
        expect(r.state.tasks).toEqual([]);
        expect(r.state.writes).toHaveLength(1);
        expect(r.state.writes[0]).toMatchObject({ path: runKey, name: hookName, type: 'String', force: true });
        // Direct executable invocation: spaces, ampersands and apostrophes remain path characters.
        // No cmd wrapper in the public directory, and no shell metacharacter interpretation.
        expect(r.state.value).toBe(`"${process.execPath}" "${r.repo}\\scripts\\perf-lag\\keychain-at-logon.mjs" "${join(r.publicDir, 'genie-keychain-at-logon.txt')}" "${r.repo}"`);
        expect(r.state.reads).toEqual([{ path: runKey, name: hookName }]);
        expect(r.state.otherValue).toBe('leave this alone');
    });

    it.each(['key-denied', 'write-denied', 'write-ignored', 'read-denied', 'read-missing', 'read-mismatch'])(
        'refuses a failed or unverified install (%s), even when the native task command would fail', (scenario) => {
            const r = run('logon-install', scenario);
            expect(r.status, r.stdout + r.stderr).not.toBe(0);
            expect(r.stdout).toContain('logon-install=FAIL');
            expect(r.stdout).not.toContain('logon-install=PASS');
        },
    );

    it('reads the result and removes only its own Run value', () => {
        const r = run('logon-read', 'ok', true);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain('fixture result');
        expect(r.state.removals).toEqual([{ path: runKey, name: hookName }]);
        expect(r.state.value).toBeNull();
        expect(r.state.otherValue).toBe('leave this alone');
    });

    it('removes the hook even when there is no result, without claiming nobody signed in', () => {
        const r = run('logon-read');
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain('logon-read=FAIL');
        expect(r.stdout).not.toContain('nobody has logged on');
        expect(r.state.removals).toEqual([{ path: runKey, name: hookName }]);
        expect(r.state.value).toBeNull();
    });

    it('reports cleanup failure instead of leaving an unnoticed persistent hook', () => {
        const r = run('logon-read', 'remove-denied', true);
        expect(r.status, r.stdout + r.stderr).not.toBe(0);
        expect(r.stdout).toContain('logon-read=FAIL');
        expect(r.state.value).toBe('old hook');
    });
});
