import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { TakeOverHost } from '../src/main/take-over-host.js';
import { TerminalHost, type PtyPort, type PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * TAKE OVER — §1: "opens a terminal in a new window running whatever TUI the user chooses".
 *
 * That window is a separate, new session — it never attaches a MANAGED agent to a pty; it is
 * not managed by Genie, which does not start, stop, restart or revive it beyond the click that
 * opens it; and it is visible as an Observed row. This file proves the host's half of all
 * three, with the pty port and the window-opener injected so nothing spawns.
 */

function recordingPty() {
    const opened: PtySpawnOptions[] = [];
    const killed: string[] = [];
    let onData: ((id: string, data: string) => void) | null = null;
    let onExit: ((id: string, code: number) => void) | null = null;
    const port: PtyPort = {
        open: (o) => { opened.push(o); return { id: `term_${opened.length}`, pid: 7000 + opened.length, shell: o.command ?? 'sh', scrollback: '' }; },
        write: () => true,
        resize: () => true,
        kill: (id) => { killed.push(id); return true; },
        scrollback: () => '',
        onData: (l) => { onData = l; return () => { onData = null; }; },
        onExit: (l) => { onExit = l; return () => { onExit = null; }; },
    };
    return { port, opened, killed, emitData: (id: string, d: string) => onData?.(id, d), emitExit: (id: string, c: number) => onExit?.(id, c) };
}

function setup() {
    const pty = recordingPty();
    const terminals = new TerminalHost(pty.port);
    const windows: string[] = [];
    let now = 1_760_000_000_000;
    const host = new TakeOverHost({
        terminals,
        openWindow: (route) => { windows.push(route); },
        clock: () => now,
    });
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'kora' });
    return { pty, terminals, windows, host, record, tick: (ms: number) => { now += ms; } };
}

describe('the MCP environment contract', () => {
    it('with a server: the TUI gets GENIE_MCP_URL, GENIE_MCP_TOKEN and a GENIE_TERMINAL_ID this host can resolve back to the agent', () => {
        const pty = recordingPty();
        const terminals = new TerminalHost(pty.port);
        const host = new TakeOverHost({ terminals, openWindow: () => {}, clock: () => 0, mcp: () => ({ mcpUrl: 'http://127.0.0.1:4242/mcp', token: 'tok' }) });
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'kora' });

        host.start(record, '/repos/tynn', 'claude');

        const env = (pty.opened[0] as { env?: Record<string, string> }).env!;
        expect(env.GENIE_MCP_URL).toBe('http://127.0.0.1:4242/mcp');
        expect(env.GENIE_MCP_TOKEN).toBe('tok');
        expect(env.GENIE_TERMINAL_ID).toMatch(/^takeover_/);
        expect(host.callerFor(env.GENIE_TERMINAL_ID!)).toEqual({ agentId: record.id, agentName: 'kora', workspaceId: 'tynn', workspacePath: '/repos/tynn' });
        expect(host.callerFor('term_1')).toBeNull();
    });

    it('without a server: NO environment — not a fake URL, not a stale one', () => {
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');
        expect('env' in (s.pty.opened[0] as object)).toBe(false);
        expect(s.host.callerFor('anything')).toBeNull();
    });
});

describe('taking over', () => {
    it('opens a terminal in the agent’s workspace running the chosen TUI, and a window for it', () => {
        const s = setup();

        const result = s.host.start(s.record, '/repos/tynn', 'claude');

        expect(result).toMatchObject({ ok: true, terminalId: 'term_1' });
        expect(s.pty.opened).toEqual([{ cwd: '/repos/tynn', command: 'claude', cols: undefined, rows: undefined }]);
        expect(s.windows).toEqual(['genie://takeover/term_1']);
    });

    it('hands the terminal host NO agent — the one rule, COUNTED at the port', () => {
        /**
         * The TUI is an agent program, and the pty it runs in belongs to a WORKSPACE, not to the
         * agent record. The link from agent to terminal lives only in this host's own map (for
         * the Observed row); nothing with an `agentId` reaches the terminal host or the port.
         */
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');

        const leaked = s.pty.opened.filter((o) => Object.keys(o).some((k) => /agent/i.test(k)));
        expect(leaked).toEqual([]);
        expect(s.terminals.list().map((t) => t.workspaceId)).toEqual(['tynn']);
    });

    it('is ONE take-over per agent — a second click focuses the window rather than opening another TUI', () => {
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');

        const again = s.host.start(s.record, '/repos/tynn', 'claude');

        expect(again).toMatchObject({ ok: true, terminalId: 'term_1' });
        expect(s.pty.opened).toHaveLength(1);
        // The window route is re-opened (the opener decides whether that means focus).
        expect(s.windows).toEqual(['genie://takeover/term_1', 'genie://takeover/term_1']);
    });

    it('refuses a TUI the agent’s AGENT.md does not list — the same rule for human and agent', () => {
        // §6.2: switching driver is refused when the persona lists `tuis:` and the requested
        // one is not among them. Take Over is a driver switch by another name.
        const s = setup();
        const result = s.host.start({ ...s.record, instructions: null }, '/repos/tynn', 'codex', { tuis: ['claude'] });
        expect(result).toMatchObject({ ok: false });
        expect(result.ok === false && result.reason).toContain('codex');
        expect(s.pty.opened).toEqual([]);
    });
});

describe('observing it', () => {
    it('measures bytes and when, and nothing else', () => {
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');

        s.pty.emitData('term_1', 'x'.repeat(300));
        s.tick(2_000);
        s.pty.emitData('term_1', 'y'.repeat(50));

        const probe = s.host.probe(s.record.id);
        expect(probe?.terminalId).toBe('term_1');
        expect(probe?.lastOutputAt).toBe(1_760_000_002_000);
        expect(probe?.bursts.map((b) => b.bytes)).toEqual([300, 50]);
    });

    it('ignores output from terminals that are not take-overs', () => {
        // The workspace's own terminals share the data channel. Their bytes are not an
        // agent's activity, and attributing them would draw bars for a build somebody ran.
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');
        s.terminals.open({ workspaceId: 'tynn', cwd: '/repos/tynn', command: 'npm test' }); // term_2

        s.pty.emitData('term_2', 'build output');

        expect(s.host.probe(s.record.id)?.bursts).toEqual([]);
    });

    it('bounds what it keeps — a chatty TUI must not grow memory for an hour', () => {
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');
        for (let i = 0; i < 1_000; i += 1) { s.pty.emitData('term_1', 'z'); s.tick(100); }

        expect(s.host.probe(s.record.id)?.bursts.length).toBeLessThanOrEqual(600);
    });

    it('is null for an agent with no take-over — never a fake Observed row', () => {
        const s = setup();
        expect(s.host.probe(s.record.id)).toBeNull();
    });
});

describe('Genie does not manage it', () => {
    it('when the TUI exits, the take-over simply ends — no restart, no revive, no fault', () => {
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');

        s.pty.emitExit('term_1', 0);

        expect(s.host.probe(s.record.id)).toBeNull();
        expect(s.pty.opened).toHaveLength(1);
    });

    it('has no stop, restart or revive of its own — COUNTED on the surface', () => {
        // The API is the enforcement: what cannot be expressed cannot be done by a refactor.
        const s = setup();
        const verbs = Object.getOwnPropertyNames(Object.getPrototypeOf(s.host)).filter((n) => /stop|restart|revive|kill|restore/i.test(n));
        expect(verbs).toEqual([]);
    });

    it('closing the window ends the terminal — the window IS the session', () => {
        const s = setup();
        s.host.start(s.record, '/repos/tynn', 'claude');

        s.host.windowClosed('term_1');

        expect(s.pty.killed).toEqual(['term_1']);
        expect(s.host.probe(s.record.id)).toBeNull();
    });
});
