import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * `STOP THIS TURN` STOPS THE TURN, NOT THE AGENT (the owner, 2026-10-15: "I hit the stop button … but it killed the
 * agent, not stopping the chat. The stop button should send a stop request to the working agent, not break the chat").
 *
 * The chat's and the Agent view's Stop called `host.stop`, which KILLS the provider. Now it asks the driver to cancel
 * the turn (prism-acp's `cancel`, 0.14.0): the session stays up, the turn ends `cancelled` → idle, the ledger and the
 * chat say `Stopped by you`, and the next message goes to the same session. Ending the agent is "Stop agent", which
 * still kills — the positive control for every "not killed" here.
 *
 * The drivers are fakes with and without `cancel`, so this file runs against any prism-acp. COUNTS, not booleans
 * (cancels, kills, reaps, rows): "not killed" passes on a driver nobody called.
 */
const dirs: string[] = [];
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-cancel-'));
    dirs.push(d);
    return d;
}
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Observes and never touches the machine; counts reaps so "not killed" includes "subtree not reaped". */
function recordingTree() {
    const reaps: (readonly unknown[])[] = [];
    const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => { reaps.push(pids); return { killed: pids.length, refused: false }; } };
    return { tree, reaps };
}

/**
 * A driver that counts cancels, kills and prompts. `cancel`: `'yes'` resolves (prism-acp 0.14's drivers), `'no'` has
 * none (prism-acp before 0.14), `'refuses'` rejects the way Codex refusing `turn/interrupt` does.
 */
function fakeDriver(cancel: 'yes' | 'no' | 'refuses' = 'yes') {
    const calls = { cancels: 0, kills: 0, prompts: 0 };
    let events: DriverEvents = {};
    let running = false;
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => { running = true; },
            prompt: () => { calls.prompts += 1; },
            kill: () => { calls.kills += 1; running = false; },
            ...(cancel === 'no' ? {} : { cancel: () => { calls.cancels += 1; return cancel === 'yes' ? Promise.resolve() : Promise.reject(new Error('turn/interrupt was refused')); } }),
            get running() { return running; },
            get cliSessionId() { return null; },
        };
        return driver;
    };
    return {
        factory,
        calls,
        endTurn: (outcome: TurnOutcomeLike) => events.onTurnEnd?.(outcome),
        askPermission: () => events.onRequestPermission?.({ toolCall: { title: 'php artisan migrate --force' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }),
    };
}

const CANCELLED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancelled' };
const FINISHED: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: null };

function session(cancel: 'yes' | 'no' | 'refuses' = 'yes') {
    const dir = tempDir();
    const d = fakeDriver(cancel);
    const t = recordingTree();
    const rows: StreamEvent[] = [];
    const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory, processTree: t.tree, onEvent: (e) => { rows.push(e); } });
    return { s, d, t, rows };
}
const stoppedRows = (rows: readonly StreamEvent[]) => rows.filter((r) => r.kind === 'stopped');
const warnings = (rows: readonly StreamEvent[], pattern: RegExp) => rows.filter((r) => r.kind === 'notice' && r.level === 'warning' && pattern.test(r.message));

describe('AgentSession.cancel — the turn ends, the session stays', () => {
    it('asks the driver ONCE and kills nothing; the turn reads idle (not failed) when the provider ends it cancelled; the next prompt goes through', () => {
        const { s, d, t } = session();
        s.start();
        expect(s.canCancelTurn).toBe(true);
        s.prompt('refactor the queue worker', 'you');
        expect(s.turnState).toBe('working');

        expect(s.cancel()).toEqual({ ok: true });
        expect(d.calls.cancels).toBe(1);
        expect(d.calls.kills).toBe(0);
        expect(t.reaps).toHaveLength(0);
        expect(s.running).toBe(true);
        // Asked, not ended: the protocol has not said the turn is over, so nothing claims it is.
        expect(s.turnState).toBe('working');

        d.endTurn(CANCELLED);
        expect(s.turnState).toBe('idle');
        expect(s.failure).toBeNull();
        expect(s.running).toBe(true);
        // Still an agent you can talk to: the next prompt reaches the SAME driver, and nothing was killed on the way.
        s.prompt('carry on with the tests only', 'you');
        expect(d.calls.prompts).toBe(2);
        expect(s.turnState).toBe('working');
        expect(d.calls).toEqual({ cancels: 1, kills: 0, prompts: 2 });
    });

    it('POSITIVE CONTROL: the explicit stop (Stop agent) still kills the driver and reaps — the same fake counts it', () => {
        const { s, d, t } = session();
        s.start();
        s.prompt('x', 'you');
        s.stop();
        expect(d.calls.kills).toBe(1);
        expect(t.reaps).toHaveLength(1);
        expect(d.calls.cancels).toBe(0);
        expect(s.turnState).toBe('stopped');
    });

    it('the cancelled turn is RECORDED as stopped by the person — once, numbered; a finished turn records none (control)', () => {
        const { s, d, rows } = session();
        s.start();
        s.prompt('first', 'you');
        d.endTurn(FINISHED);
        expect(stoppedRows(rows)).toHaveLength(0);

        s.prompt('second', 'you');
        s.cancel();
        d.endTurn(CANCELLED);
        expect(stoppedRows(rows)).toEqual([{ kind: 'stopped', n: 2, by: 'you' }]);
    });

    it('a turn the provider ends cancelled with NOBODY here asking is recorded stopped `by: null` — never guessed to be you', () => {
        const { s, d, rows } = session();
        s.start();
        s.prompt('x', 'you');
        d.endTurn(CANCELLED);
        expect(stoppedRows(rows)).toEqual([{ kind: 'stopped', n: 1, by: null }]);
        expect(s.turnState).toBe('idle');
    });

    it('with no turn running it does nothing and says so; the same session cancels once a turn runs (control)', () => {
        const { s, d } = session();
        expect(s.cancel()).toEqual({ ok: false, reason: 'not-running' });
        s.start();
        expect(s.cancel()).toEqual({ ok: false, reason: 'no-turn' });
        s.prompt('x', 'you');
        d.endTurn(FINISHED);
        expect(s.cancel()).toEqual({ ok: false, reason: 'no-turn' });
        expect(d.calls.cancels).toBe(0);

        s.prompt('y', 'you');
        expect(s.cancel()).toEqual({ ok: true });
        expect(d.calls.cancels).toBe(1);

        s.stop();
        expect(s.cancel()).toEqual({ ok: false, reason: 'not-running' });
        expect(d.calls.cancels).toBe(1);
    });

    it('a prompt queued behind the stopped turn still gets ITS turn (measured: Claude runs it after the interrupt), after the stopped row', () => {
        const { s, d, rows } = session();
        s.start();
        s.prompt('first', 'you');
        s.prompt('second, sent mid-turn', 'you');
        expect(s.cancel()).toEqual({ ok: true });
        d.endTurn(CANCELLED);
        expect(s.turnState).toBe('working');
        const order = rows.filter((r) => r.kind === 'turn' || r.kind === 'stopped').map((r) => (r.kind === 'turn' ? `turn ${r.n}` : r.kind === 'stopped' ? `stopped ${r.n}` : ''));
        expect(order).toEqual(['turn 1', 'stopped 1', 'turn 2']);
        expect(d.calls.kills).toBe(0);
    });

    it('a parked approval is answered `cancelled` (ACP’s rule for a cancelled turn) and leaves one cancelled decision row', async () => {
        const { s, d, rows } = session();
        s.start();
        s.prompt('migrate', 'you');
        const answer = d.askPermission();
        expect(s.pendingApproval).not.toBeNull();

        expect(s.cancel()).toEqual({ ok: true });
        await expect(answer).resolves.toEqual({ outcome: 'cancelled' });
        expect(s.pendingApproval).toBeNull();
        expect(s.parkedAt).toBeNull();
        expect(rows.filter((r) => r.kind === 'approval' && r.outcome === 'cancelled')).toHaveLength(1);
        expect(d.calls.kills).toBe(0);
    });

    it('a driver WITHOUT a turn cancel is never killed in its place: `unsupported`, one warning in the stream, the turn runs on', () => {
        const { s, d, t, rows } = session('no');
        s.start();
        expect(s.canCancelTurn).toBe(false);
        s.prompt('x', 'you');
        expect(s.cancel()).toEqual({ ok: false, reason: 'unsupported' });
        expect(d.calls.kills).toBe(0);
        expect(t.reaps).toHaveLength(0);
        expect(s.running).toBe(true);
        expect(s.turnState).toBe('working');
        expect(warnings(rows, /cannot stop a turn/)).toHaveLength(1);
    });

    it('a REFUSED interrupt is said in the stream and kills nothing; the turn runs on and, when it finishes, records no stop', async () => {
        const { s, d, t, rows } = session('refuses');
        s.start();
        s.prompt('x', 'you');
        expect(s.cancel()).toEqual({ ok: true });
        expect(d.calls.cancels).toBe(1);
        await vi.waitFor(() => expect(warnings(rows, /could not be stopped: turn\/interrupt was refused/)).toHaveLength(1));
        expect(d.calls.kills).toBe(0);
        expect(t.reaps).toHaveLength(0);
        expect(s.running).toBe(true);
        d.endTurn(FINISHED);
        expect(stoppedRows(rows)).toHaveLength(0);
        expect(s.turnState).toBe('idle');
    });
});

describe('SessionHost.cancel — the slot stays, the agent keeps running', () => {
    function host(cancel: 'yes' | 'no' = 'yes') {
        const dir = tempDir();
        const counts = { cancels: 0, kills: 0 };
        let events: DriverEvents = {};
        const driverFor: DriverFor = () => (options) => {
            events = options.events;
            let running = false;
            return {
                start: () => { running = true; },
                prompt: () => {},
                kill: () => { counts.kills += 1; running = false; },
                ...(cancel === 'yes' ? { cancel: () => { counts.cancels += 1; return Promise.resolve(); } } : {}),
                get running() { return running; },
                get cliSessionId() { return null; },
            };
        };
        const noTree: ProcessTree = { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) };
        const h = new SessionHost({ userData: dir, driverFor, processTree: noTree });
        return { h, dir, counts, endTurn: (o: TurnOutcomeLike) => events.onTurnEnd?.(o) };
    }

    it('cancels the running turn once, keeps the session in the map and running; stop (control) kills and frees the slot', () => {
        const { h, dir, counts, endTurn } = host();
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'ws_example', provider: 'claude', name: 'atlas' });
        expect(h.start(agent, dir)).toEqual({ ok: true });
        expect(h.prompt(agent.id, 'go', 'you')).toBe(true);

        expect(h.cancel(agent.id)).toEqual({ ok: true });
        expect(counts).toEqual({ cancels: 1, kills: 0 });
        expect(h.count).toBe(1);
        expect(h.probe(agent.id)?.running).toBe(true);
        endTurn(CANCELLED);
        expect(h.probe(agent.id)?.turnState).toBe('idle');
        expect(h.ledgerFor(agent.id).filter((r) => r.event.kind === 'stopped')).toHaveLength(1);

        expect(h.stop(agent.id)).toBe(true);
        expect(counts).toEqual({ cancels: 1, kills: 1 });
        expect(h.count).toBe(0);
        expect(h.cancel(agent.id)).toEqual({ ok: false, reason: 'not-running' });
        expect(counts.cancels).toBe(1);
    });

    it('an agent whose driver has no turn cancel is probed `cancelTurn: false` — no turn Stop is offered on it', () => {
        const { h, dir } = host('no');
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'ws_example', provider: 'claude', name: 'wren' });
        expect(h.start(agent, dir)).toEqual({ ok: true });
        expect(h.probe(agent.id)?.cancelTurn).toBe(false);
    });
});

/** Source, with `//` comments dropped by line, so a comment naming a call cannot satisfy a check for the call. */
const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');

describe('the wiring — every turn Stop reaches cancel; "Stop agent" still stops', () => {
    it('main handles genie:cancel-turn with host.cancel (never host.stop), and the remote host API maps host.cancel', () => {
        const main = source('../src/main/main.ts');
        const handler = main.match(/ipcMain\.handle\('genie:cancel-turn'[^]*?\n {4}\}\);/)?.[0] ?? '';
        expect(handler).toContain('host.cancel(record.id)');
        expect(handler).not.toContain('.stop(');
        expect(main.match(/cancel: \(id\) => host!\.cancel\(id\)/g) ?? []).toHaveLength(1);
        // Control: the session-ending handler is still there, still stopping.
        expect(main).toMatch(/ipcMain\.handle\('genie:stop-agent'[^]*?host\.stop\(record\.id\)/);
        expect(source('../src/main/preload.ts')).toMatch(/cancelTurn: \(agentId\) => ipcRenderer\.invoke\('genie:cancel-turn', agentId\)/);
        expect(source('../src/renderer/remote-bridge.ts')).toMatch(/cancelTurn: \(agentId\) => answer<[^>]*>\('cancelTurn', agentId\)/);
    });

    it('the Agent view header’s turn Stop calls onCancelTurn; the menu’s stop-agent calls onStop; the chat’s turn Stop is wired to onCancelTurn', () => {
        const view = source('../src/renderer/components/AgentView.tsx');
        const turnStop = view.match(/<TurnStop [^\n]*/g) ?? [];
        expect(turnStop).toHaveLength(1);
        expect(turnStop[0]).toContain('onStop={() => onCancelTurn(agent.id)}');
        expect(view).toMatch(/if \(id === 'stop-agent'\) onStop\?\.\(agent\.id\);/);
        // The old header Stop that called onStop is gone.
        expect(view).not.toMatch(/data-action="stop"/);

        const shell = source('../src/renderer/Shell.tsx');
        const flyout = shell.match(/<ChatFlyout[^]*?\/>/)?.[0] ?? '';
        expect(flyout).toMatch(/onStopTurn=\{[^\n]*onCancelTurn\?\.\(chatThread\.agentId\)[^\n]*\}/);
        expect(flyout).not.toContain('onStopAgent');
        expect(shell).toMatch(/onCancelTurn=\{onCancelTurn\}/);

        const app = source('../src/renderer/App.tsx');
        expect(app).toMatch(/onCancelTurn=\{\(agentId\) => \{ void resolvedBridge\?\.cancelTurn\(agentId\); \}\}/);
        // Control: Stop agent still reaches the bridge's stop.
        expect(app).toMatch(/onStopAgent=\{\(agentId\) => \{ resolvedBridge\?\.stopAgent\(agentId\); \}\}/);
    });
});
