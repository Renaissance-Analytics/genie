import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLAUDE_DRIVER_CAPABILITIES, CODEX_DRIVER_CAPABILITIES, ClaudeDriver, CodexDriver } from '@particle-academy/prism-acp';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, turnCancelFor, type DriverFor } from '../src/main/session-host.js';

/**
 * THE REAL DRIVERS CAN STOP A TURN — prism-acp 0.14.0 (Particle-Academy/prism-acp-ts#17): `AgentDriver.cancel?()` and
 * `DriverCapabilities.cancel`, `true` for Claude and Codex. NEEDS prism-acp >= 0.14.0 INSTALLED: against 0.13 every test
 * here is red, by design — it is the gauge that the bump landed, and the positive control for the `cancelTurn: false`
 * case in test/stop-cancels-turn.test.ts (a fake driver with no cancel).
 *
 * Genie offers `Stop this turn` only when BOTH say so: the driver's declaration (`turnCancelFor`) and the method on the
 * driver it actually holds. The two are checked to agree here, so a prism-acp that declared one without the other
 * would be caught rather than offering a Stop that cannot work.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('prism-acp declares a turn cancel, and its drivers have one', () => {
    it('Claude and Codex both declare `cancel: true`, and Genie reads it', () => {
        expect((CLAUDE_DRIVER_CAPABILITIES as Readonly<Record<string, unknown>>)['cancel']).toBe(true);
        expect((CODEX_DRIVER_CAPABILITIES as Readonly<Record<string, unknown>>)['cancel']).toBe(true);
        expect(turnCancelFor('claude')).toBe(true);
        expect(turnCancelFor('codex')).toBe(true);
        // A provider Genie has no driver for is unknown, not "no" and not "yes".
        expect(turnCancelFor('aider')).toBeNull();
    });

    it('the declaration and the method agree for each driver (no Stop is offered on a claim the driver cannot keep)', () => {
        expect(typeof (ClaudeDriver.prototype as unknown as Record<string, unknown>)['cancel']).toBe('function');
        expect(typeof (CodexDriver.prototype as unknown as Record<string, unknown>)['cancel']).toBe('function');
    });
});

describe('the probe offers the turn Stop on a claude agent whose driver can cancel', () => {
    it('cancelTurn: true — declared by prism-acp AND present on the session’s driver', () => {
        const dir = mkdtempSync(join(tmpdir(), 'genie2-cancel-014-'));
        dirs.push(dir);
        const driverFor: DriverFor = () => () => {
            let running = false;
            return {
                start: () => { running = true; },
                prompt: () => {},
                kill: () => { running = false; },
                cancel: () => Promise.resolve(),
                get running() { return running; },
                get cliSessionId() { return null; },
            };
        };
        const noTree: ProcessTree = { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) };
        const h = new SessionHost({ userData: dir, driverFor, processTree: noTree });
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'ws_example', provider: 'claude', name: 'atlas' });
        expect(h.start(agent, dir)).toEqual({ ok: true });
        expect(h.probe(agent.id)?.cancelTurn).toBe(true);
    });
});
