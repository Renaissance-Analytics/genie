import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';

/*
 * AN INTERRUPT IS NOT A STOP (Tynn #672 part 3). "Stop this turn" latches: the session stops taking Genie's notices
 * until the person acts (genie#1565, #stoppedByYou). But "Interrupt and send" cancels the running turn so that the
 * person's message, already handed over, runs next: the person's message IS the next work. It used to latch exactly like
 * Stop (the same cancelTurn, by 'you'), so when Claude had folded that message into the turn the interrupt cancelled, the
 * session sat non-deliverable, and Genie's mail notices waited until the person typed again.
 */
const NOTICE = 'You have 1 unread AgentInbox message; collect it with agentinbox receive.';
const CANCELLED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancelled' };

describe('AgentSession: an interrupt-and-send does not latch Stop', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-interrupt-latch-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    function session() {
        const prompts: unknown[] = [];
        let events: DriverEvents = {};
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            const driver: SessionDriver = {
                start: () => {},
                prompt: (content) => { prompts.push(content); },
                cancel: () => Promise.resolve(),
                kill: () => {},
                get running() { return true; },
                get cliSessionId() { return null; },
            };
            return driver;
        };
        const rows: StreamEvent[] = [];
        const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
        const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: tree, onEvent: (e) => { rows.push(e); } });
        return { s, prompts, endTurn: (o: TurnOutcomeLike) => events.onTurnEnd?.(o) };
    }

    it('interrupt-and-send, then mail: the notice reaches the agent without the person typing', async () => {
        const { s, prompts, endTurn } = session();
        s.start();
        s.prompt('work', 'you');
        // The person's message mid-turn: Claude folds it into the running turn (the provider has it now).
        expect(s.deliver('the next thing to do', 'you', null)).toBeNull();
        // Interrupt and send: the composer cancels the turn so that message runs next.
        expect(s.cancel('you', 'interrupt')).toEqual({ ok: true });
        endTurn(CANCELLED);
        await Promise.resolve();
        expect(s.inTurn).toBe(false);
        expect(s.stoppedByYou, 'an interrupt is not a Stop').toBe(false);
        expect(s.deliverable, 'the session takes Genie\'s notices again').toBe(true);
        // Mail arrives: Genie's notice is delivered now, not held until the person types.
        expect(s.deliver(NOTICE, 'genie', null, { retold: true })).toBeNull();
        expect(prompts).toContain(NOTICE);
    });

    it('CONTROL: "Stop this turn" still latches, and the same notice waits for the person', async () => {
        const { s, prompts, endTurn } = session();
        s.start();
        s.prompt('work', 'you');
        expect(s.deliver('the next thing to do', 'you', null)).toBeNull();
        expect(s.cancel('you', 'stop')).toEqual({ ok: true });
        endTurn(CANCELLED);
        await Promise.resolve();
        expect(s.stoppedByYou).toBe(true);
        expect(s.deliverable).toBe(false);
        expect(prompts).not.toContain(NOTICE);
    });

    it('a cancel that names no intent is a Stop, as before (the default)', async () => {
        const { s, endTurn } = session();
        s.start();
        s.prompt('work', 'you');
        expect(s.cancel()).toEqual({ ok: true });
        endTurn(CANCELLED);
        await Promise.resolve();
        expect(s.stoppedByYou).toBe(true);
    });
});

describe('the interrupt reaches the session as an interrupt, on every route', () => {
    const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

    it('the chat\'s Interrupt and send asks for an interrupt; its Stop this turn asks for a stop', () => {
        const shell = read('src/renderer/Shell.tsx');
        expect(shell).toMatch(/onInterruptAndSend=\{chatTurnStop && chatThread \? \(\) => onCancelTurn\?\.\(chatThread\.agentId, 'interrupt'\)/);
        expect(shell).toMatch(/onStopTurn=\{chatTurnStop && chatThread \? \(\) => onCancelTurn\?\.\(chatThread\.agentId, 'stop'\)/);
    });

    it('the bridges, the IPC, the remote protocol and the engine carry it to SessionHost.cancel', () => {
        expect(read('src/renderer/App.tsx')).toMatch(/onCancelTurn=\{\(agentId, intent\) => \{ void resolvedBridge\?\.cancelTurn\(agentId, intent\); \}\}/);
        expect(read('src/main/preload.ts')).toMatch(/cancelTurn: \(agentId, intent\) => ipcRenderer\.invoke\('genie:cancel-turn', agentId, intent\)/);
        expect(read('src/renderer/remote-bridge.ts')).toMatch(/cancelTurn: \(agentId, intent\) => answer<[^>]*>\('cancelTurn', agentId, intent\)/);
        expect(read('src/main/main.ts')).toMatch(/ipcMain\.handle\('genie:cancel-turn', \(_event, raw: unknown, intent: unknown\) => \{[^}]*host\.cancel\(record\.id, 'you', cancelIntent\(intent\)\)/);
        expect(read('src/main/main.ts')).toMatch(/cancel: \(id, intent\) => host!\.cancel\(id, 'you', intent\)/);
        expect(read('src/main/host-api.ts')).toMatch(/deps\.host\.cancel\(r\.id, cancelIntent\(args\[1\]\)\)/);
        expect(read('src/main/session-engine-server.ts')).toMatch(/host\.cancel\(id\(\), by\(1\), cancelIntent\(args\[2\]\)\)/);
        expect(read('src/main/session-host.ts')).toMatch(/entry\.session\.cancel\(by, intent\)/);
    });
});
