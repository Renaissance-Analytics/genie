import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A SOURCE GUARD on the one-line seam.
 *
 * `isTerminalLive` in `main/terminal/ipc.ts` is the single function that decides whether
 * an agent is alive, for the roster, the agent cap, drain, triage, `savedAgentsOf` and
 * `runAgent`. Revert it to the pty alone and an ACP session reads as dead in every one of
 * them at once — drain lets an upgrade proceed over a working agent, triage prescribes a
 * restart for something running fine.
 *
 * It cannot be unit-tested in place: `ipc.ts` is 115 KB, imports electron and the database,
 * and ships with no test of its own. So the composition is tested as a decision in
 * `terminalIsLive` and the WIRING is guarded here.
 *
 * CRLF-normalised before matching, because genie#517 is this repo's source-reading guards
 * going inert on `\r\n` — a guard that silently stops guarding is worse than none.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ipc = fs.readFileSync(path.join(ROOT, 'main/terminal/ipc.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('isTerminalLive composes both engines', () => {
    it('is a function, not a re-export of the pty check', () => {
        // `export { ptyIsLive as isTerminalLive }` is what it used to be, and reverting to
        // it is the exact regression this guard exists for.
        expect(ipc).toMatch(/export function isTerminalLive\(/);
        expect(ipc).not.toMatch(/export \{ ptyIsLive as isTerminalLive \}/);
    });

    it('asks the ACP registry as well as the pty', () => {
        expect(ipc).toContain('acpRegistry.isLive');
        expect(ipc).toContain('ptyIsLive');
    });

    it('delegates to the tested composition rather than re-deriving it', () => {
        // The or-condition lives in `terminalIsLive`, where a test can break it.
        expect(ipc).toContain('terminalIsLive(id, {');
    });

    it('positive control: the guard reads the real file', () => {
        // Without this, every assertion above would also pass against an empty string.
        expect(ipc).toContain('deliverAgentLaunch');
        expect(ipc.length).toBeGreaterThan(50_000);
    });
});
