import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { answerSecondInstance, secondInstanceAction } from '../src/core/quit-flag.js';

/**
 * EVERY SHELL CALL RAISED GENIE (genie#1235). Since genie#1188 (a6e47511, beta.44) every Claude agent runs with
 * prism-acp's `permissionPrompts` hook on Bash and PowerShell, and inside Genie that hook's runtime is Genie.exe. Before
 * prism-acp 0.30.0 the hook launched it WITHOUT ELECTRON_RUN_AS_NODE: a SECOND GENIE, which asked the single-instance
 * lock, and the running Genie answered `second-instance` by revealing and focusing its window.
 *
 * prism-acp 0.30.0 runs the hook as Node (ELECTRON_RUN_AS_NODE=1 for the hook process alone), so a hook launch never
 * reaches main: test/prism-hook-runs-as-node.test.ts measures that. main.ts's own hook branch (genie#1237) is removed.
 * What stays, as defence in depth: a running Genie never reveals for a second launch that carries a script.
 */

const INSTALLED = 'C:/Users/example/AppData/Local/Programs/Genie/Genie.exe';
const HOOK = 'C:/Users/example/AppData/Local/Temp/prism-acp-mcp-a1b2c3/approve.cjs';

describe('a second launch that carries a script never raises Genie', () => {
    it('secondInstanceAction ignores it', () => {
        expect(secondInstanceAction([INSTALLED, HOOK], {})).toBe('ignore');
        expect(secondInstanceAction([INSTALLED, 'C:/anything/run.js'], undefined)).toBe('ignore');
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

describe('main answers every second launch through that rule', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the `second-instance` handler is answerSecondInstance, so a script launch is ignored there too', () => {
        expect(main).toMatch(/app\.on\('second-instance', \(_event, argv, _workingDirectory, additionalData\) => \{\s*answerSecondInstance\(argv, additionalData,/);
    });
});
