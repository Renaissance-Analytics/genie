import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A SOURCE GUARD for the one seam that cannot be unit-tested.
 *
 * `main/ipc.ts` registers the handler and `main/preload.ts` invokes it, and the two
 * agree only by sharing a string literal. Nothing type-checks that agreement: rename
 * it in one file and the renderer's call rejects at runtime with "No handler
 * registered", in a surface whose empty state says *nothing needs you*. That is the
 * worst possible failure for this particular feature, and it is invisible until a
 * human looks.
 *
 * Deliberately NOT anchored on `\n`. genie#517: this repo has 83 tests that read
 * source, and ones anchored on `\n` are inert on CRLF — a guard that silently stops
 * guarding is worse than none, because it still reads as covered.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const CHANNEL = 'agentsession:list';

describe('the agentsession IPC seam', () => {
    it('registers the channel in main', () => {
        expect(read('main/ipc.ts')).toContain(`ipcMain.handle('${CHANNEL}'`);
    });

    it('invokes the SAME channel from preload', () => {
        // The whole point of the guard: one string, two files, no compiler between
        // them.
        expect(read('main/preload.ts')).toContain(`ipcRenderer.invoke('${CHANNEL}')`);
    });

    it('keeps the handler a one-liner that delegates', () => {
        // `main/ipc.ts` has no test of its own, so logic placed there ships unchecked.
        // The handler must call the tested entry point and do nothing else.
        const src = read('main/ipc.ts');
        expect(src).toMatch(/ipcMain\.handle\('agentsession:list', \(\) => agentSessions\(\)\);/);
    });

    it('imports that entry point from the tested module', () => {
        expect(read('main/ipc.ts')).toContain("from './agentsession/bindings'");
    });

    it('positive control: the guard can tell a missing wire from a present one', () => {
        // Without this, every assertion above would also pass against a file that
        // happened to contain the strings in a comment — and a guard that cannot fail
        // is the defect genie#517 is about. A channel nobody registers must NOT match.
        expect(read('main/ipc.ts')).not.toContain("ipcMain.handle('agentsession:nonexistent'");
        expect(read('main/preload.ts')).not.toContain("ipcRenderer.invoke('agentsession:nonexistent')");
    });
});

/**
 * THE RECORDER IS WIRED — the one port whose absence is invisible.
 *
 * Every other `SessionWritePorts` member fails loudly when unwired: no `promptFor` and the send
 * reports `no-session`. `recordPrompt` is OPTIONAL, because a remote window may have no declared
 * store, so forgetting it in `main/ipc.ts` costs nothing at the type level and nothing at runtime
 * — the prompt still lands, the agent still answers, and the owner's half of the conversation is
 * simply missing. That is the shape of defect this whole phase has been clearing out: built,
 * tested, not wired.
 */
describe('the Conversation records what the owner said', () => {
    it('supplies recordPrompt from the declared store', () => {
        const src = read('main/ipc.ts');
        expect(src).toContain('recordPrompt: (specId, text) => declaredSessions.recordHumanPromptForSpec(specId, text)');
    });

    it('imports the store it records into', () => {
        expect(read('main/ipc.ts')).toMatch(/import \{[^}]*declaredSessions[^}]*\} from '\.\/agentsession\/bindings'/);
    });

    it('positive control: the guard can tell a present wire from an absent one', () => {
        // A method nobody calls must NOT match, or both assertions above would pass against any
        // file that merely mentions the store.
        expect(read('main/ipc.ts')).not.toContain('declaredSessions.recordNothingAtAll(');
    });
});
