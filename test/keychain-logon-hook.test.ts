import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const hookName = 'GenieKeychainAtLogon';
const fixtures: string[] = [];
/** How long one PowerShell run may take before spawnSync ends it (and the row fails with spawnSync's own error). */
const SPAWN_LIMIT_MS = 20_000;
/*
 * EACH ROW'S BUDGET: the spawn's own limit plus 5 s for the fixture and the assertions, so a hung PowerShell is ended and
 * reported by the spawn, not cut off by vitest. Measured (measure/keychain-hook-time, run 42387692679, this file alone, 5
 * runs on each system): the FIRST row carries PowerShell's cold start, 0.9 to 5.4 s on Linux (pwsh) and 3.7 to 4.7 s on
 * Windows; every other row took at most 0.99 s (Linux) and 0.53 s (Windows). Vitest's default 5 s cut the first row off on
 * Linux's typecheck + unit (jobs 128441347018 and 128444743188).
 */
const ROW_TIMEOUT_MS = 1; // BREAK PROBE: every row must time out at 1 ms, proving the describe-level timeout reaches each row
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

// These tests execute PowerShell, not assertions about its source. The harness replaces
// registry/task commands, so a standard user, a refused write, and stale readback are deterministic.
function run(phase: 'logon-install' | 'logon-read', scenario = 'ok', hasResult = false) {
    const root = mkdtempSync(join(tmpdir(), 'genie-logon-'));
    fixtures.push(root);
    const cwd = join(root, 'repo space');
    const repo = scenario === 'long-command' ? `C:\\${'long-directory'.repeat(30)}` : "C:\\repo space & O'Brien";
    const publicDir = join(root, 'public space');
    mkdirSync(cwd); mkdirSync(publicDir);
    if (hasResult) writeFileSync(join(publicDir, 'genie-keychain-at-logon.txt'), 'fixture result\n');
    const stateFile = join(root, 'state.json');
    const r = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./fixtures/keychain-logon-harness.ps1', import.meta.url)),
    ], {
        cwd, windowsHide: true, encoding: 'utf8', timeout: SPAWN_LIMIT_MS,
        env: { ...process.env, PUBLIC: publicDir, HOOK_SCRIPT: resolve('scripts/perf-lag/keychain-sessions-windows.ps1'), HOOK_PHASE: phase, HOOK_CASE: scenario, HOOK_STATE: stateFile, HOOK_REPO: repo },
    });
    if (r.error) throw r.error;
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        value: string | null; otherValue: string;
        keyExists: boolean; creates: { path: string; force: boolean }[];
        writes: { path: string; name: string; value: string; type: string; force: boolean }[];
        reads: { path: string; name: string }[];
        removals: { path: string; name: string }[]; tasks: string[][];
    };
    return { ...r, state, repo, publicDir };
}

describe('the Windows keychain sign-in hook, through its real phases', { timeout: ROW_TIMEOUT_MS }, () => {
    it('installs and verifies a per-user string value without needing scheduled-task permission', () => {
        const r = run('logon-install');
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain('logon-install=PASS');
        expect(r.state.tasks).toEqual([]);
        expect(r.state.writes).toHaveLength(1);
        expect(r.state.writes[0]).toMatchObject({ path: runKey, name: hookName, type: 'String', force: true });
        // Direct executable invocation: spaces, ampersands and apostrophes remain path characters.
        // No cmd wrapper in the public directory, and no shell metacharacter interpretation.
        expect(r.state.value).toBe(`"C:\\Program Files\\nodejs\\node.exe" "${r.repo}\\scripts\\perf-lag\\keychain-at-logon.mjs" "${join(r.publicDir, 'genie-keychain-at-logon.txt')}" "${r.repo}"`);
        expect(r.state.reads).toEqual([{ path: runKey, name: hookName }]);
        expect(r.state.otherValue).toBe('leave this alone');
        expect(r.state.creates).toEqual([]);
    });

    it('creates a missing Run key without replacing an existing key', () => {
        const r = run('logon-install', 'new-key');
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.state.creates).toEqual([{ path: runKey, force: false }]);
        expect(r.state.reads).toEqual([{ path: runKey, name: hookName }]);
        expect(r.state.writes).toHaveLength(1);
    });

    it.each(['key-denied', 'write-denied', 'write-ignored', 'read-denied', 'read-missing', 'read-mismatch'])(
        'refuses a failed or unverified install (%s), even when the native task command would fail', (scenario) => {
            const r = run('logon-install', scenario);
            expect(r.status, r.stdout + r.stderr).not.toBe(0);
            expect(r.stdout).toContain('logon-install=FAIL');
            expect(r.stdout).not.toContain('logon-install=PASS');
        },
    );

    it('refuses a command longer than the Run key limit before writing it', () => {
        const r = run('logon-install', 'long-command');
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain('logon-install=FAIL');
        expect(r.stdout).toContain('260');
        expect(r.state.writes).toEqual([]);
    });

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

    it.each(['remove-denied', 'remove-ignored', 'cleanup-read-denied'])('reports cleanup failure (%s) instead of leaving an unnoticed persistent hook', (scenario) => {
        const r = run('logon-read', scenario, true);
        expect(r.status, r.stdout + r.stderr).not.toBe(0);
        expect(r.stdout).toContain('logon-read=FAIL');
        expect(r.state.value).toBe('old hook');
    });

    it('allows reading the result again after the hook was removed', () => {
        const r = run('logon-read', 'already-removed', true);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain('fixture result');
        expect(r.state.removals).toEqual([]);
        expect(r.state.otherValue).toBe('leave this alone');
    });
});
