import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { answerSecondInstance, prismHookScript, secondInstanceAction } from '../src/core/quit-flag.js';

/**
 * EVERY SHELL CALL RAISED GENIE (genie#1235). Since genie#1188 (a6e47511, beta.44) every Claude agent runs with
 * prism-acp's `permissionPrompts` hook on Bash and PowerShell. prism-acp writes that hook as
 * `"<process.execPath>" "<private dir>/approve.cjs"` — and inside Genie `process.execPath` is Genie.exe. Without
 * ELECTRON_RUN_AS_NODE, Claude's hook launch of Genie.exe is a SECOND GENIE: it asked the single-instance lock, the running
 * Genie answered `second-instance` by revealing and focusing its main window (the caret back in the chat composer), and the
 * hook script never ran — so its answer never reached the agent's setting either (exit 0, no decision: the call ran).
 *
 * Genie now recognises that launch BEFORE the lock (prism's channel is in its environment, its argument is the hook
 * script) and runs the script as Node; and a running Genie never reveals for a second launch that carries a script.
 */

const INSTALLED = 'C:\\Users\\example\\AppData\\Local\\Programs\\Genie\\Genie.exe';
const HOOK = 'C:\\Users\\example\\AppData\\Local\\Temp\\prism-acp-mcp-a1b2c3\\approve.cjs';
const CHANNEL = { PRISM_ACP_APPROVAL_SOCKET: '\\\\.\\pipe\\prism-acp-0123456789abcdef01234567', PRISM_ACP_APPROVAL_TOKEN: 'f'.repeat(64) };

describe('prismHookScript — the approval hook launching Genie.exe', () => {
    it('is recognised from the hook script argument and prism-acp\u2019s channel in the environment', () => {
        expect(prismHookScript([INSTALLED, HOOK], CHANNEL)).toBe(HOOK);
        expect(prismHookScript(['/opt/Genie/genie', '/tmp/prism-acp-mcp-x/approve.cjs'], CHANNEL)).toBe('/tmp/prism-acp-mcp-x/approve.cjs');
        // Chromium may add switches of its own around it.
        expect(prismHookScript([INSTALLED, '--allow-file-access-from-files', HOOK], CHANNEL)).toBe(HOOK);
    });

    it('CONTROL: a person\u2019s launch, a launch without the channel, or another script is not the hook', () => {
        expect(prismHookScript([INSTALLED], CHANNEL)).toBeNull();
        expect(prismHookScript([INSTALLED, '--hidden'], CHANNEL)).toBeNull();
        expect(prismHookScript([INSTALLED, HOOK], {})).toBeNull();
        expect(prismHookScript([INSTALLED, HOOK], { PRISM_ACP_APPROVAL_SOCKET: CHANNEL.PRISM_ACP_APPROVAL_SOCKET })).toBeNull();
        expect(prismHookScript([INSTALLED, 'C:\\work\\evil.cjs'], CHANNEL)).toBeNull();
        // argv[0] is the executable, never the script.
        expect(prismHookScript([HOOK], CHANNEL)).toBeNull();
    });
});

describe('a second launch that carries a script never raises Genie', () => {
    it('secondInstanceAction ignores it', () => {
        expect(secondInstanceAction([INSTALLED, HOOK], {})).toBe('ignore');
        expect(secondInstanceAction([INSTALLED, 'C:\\anything\\run.js'], undefined)).toBe('ignore');
        expect(secondInstanceAction([INSTALLED, '/tmp/x/run.mjs'], null)).toBe('ignore');
    });

    it('answerSecondInstance neither reveals, nor opens, nor quits for it', () => {
        const act = { quit: vi.fn(), reveal: vi.fn(), defer: vi.fn((run: () => void) => run()), open: vi.fn() };
        expect(answerSecondInstance([INSTALLED, HOOK], {}, act)).toBe('ignore');
        expect(act.reveal).not.toHaveBeenCalled();
        expect(act.quit).not.toHaveBeenCalled();
        expect(act.open).not.toHaveBeenCalled();
    });

    it('CONTROL: the person\u2019s plain second launch still reveals; --quit still quits', () => {
        const act = { quit: vi.fn(), reveal: vi.fn(), defer: vi.fn((run: () => void) => run()), open: vi.fn() };
        expect(answerSecondInstance([INSTALLED], {}, act)).toBe('reveal');
        expect(act.reveal).toHaveBeenCalledTimes(1);
        expect(answerSecondInstance([INSTALLED, '--quit'], {}, act)).toBe('quit');
        expect(act.quit).toHaveBeenCalledTimes(1);
    });
});

describe('main runs the hook as Node, before the single-instance lock', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the hook is checked first, and the lock is never asked for it (asking alone notifies the running Genie)', () => {
        const hookAt = main.indexOf('const hookScript = prismHookScript(process.argv, process.env);');
        const lockAt = main.indexOf('app.requestSingleInstanceLock(');
        expect(hookAt).toBeGreaterThan(0);
        expect(lockAt).toBeGreaterThan(hookAt);
        expect(main).toMatch(/const launch: LaunchDecision = hookScript !== null\s*\? \{ kind: 'exit', reason: '' \}\s*: launchDecision\(\{/);
    });

    it('the script runs in Genie\u2019s own runtime as Node, on the hook\u2019s own stdin and stdout, and its exit code is the hook\u2019s', () => {
        expect(main).toMatch(/spawnSync\(process\.execPath, \[hookScript\], \{ stdio: 'inherit', env: \{ \.\.\.process\.env, ELECTRON_RUN_AS_NODE: '1' \}, windowsHide: true \}\)/);
        expect(main).toMatch(/app\.exit\(ran\.status \?\? 2\);/);
    });

    it('a hook launch writes nothing of its own to stdout (the hook\u2019s stdout is its answer)', () => {
        expect(main).toMatch(/if \(launch\.kind === 'exit' && hookScript === null\) \{\s*console\.log\(`\[genie\] \$\{launch\.reason\}`\);\s*app\.exit\(0\);\s*\}/);
    });
});
