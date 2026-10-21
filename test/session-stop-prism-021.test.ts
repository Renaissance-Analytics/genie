import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type SessionDriver } from '../src/core/session.js';
import { processTable } from './support/process-table.js';

/**
 * PRISM-ACP 0.21.1 OWNS THE PROVIDER'S TREE (hosting plan phase 1, carried as beta.35 item 4). Every provider now runs
 * under prism's supervisor — a Job Object on Windows, a process group elsewhere — and `driver.stop({ graceMs })` closes
 * stdin, waits the grace, ends the whole tree and reports it. A graceful stop therefore goes through the DRIVER'S stop,
 * once; Genie's own reading (#1022) stays as the second check and the ledger's evidence — a stop is VERIFIED only when
 * Genie's fresh reading finds nothing of the run, whatever the driver said. A stop with no grace (quit, upgrade) stays
 * synchronous: the driver's kill, which in 0.21 ends the tree, and Genie's reap before `stop` returns.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const SELF = process.pid;
const SUPERVISOR = 920_001;
const PROVIDER = 920_002;
const MCP = 920_003;
const SIBLING = 920_100;

function harness(stopBehaviour: 'ends-tree' | 'leaves-one' | 'rejects' | 'none') {
    const t = processTable(SELF);
    t.spawn(SIBLING, SELF, 'fancy-pty-helper.exe');
    const calls: string[] = [];
    const driver: SessionDriver = {
        start: () => { t.spawn(SUPERVISOR, SELF, 'node.exe'); t.spawn(PROVIDER, SUPERVISOR, 'claude.exe'); },
        prompt: () => {},
        kill: () => { calls.push('kill'); t.exit(PROVIDER); t.exit(SUPERVISOR); },
        endInput: () => { calls.push('endInput'); },
        cliSessionId: null,
        ...(stopBehaviour === 'none' ? {} : {
            stop: async (options?: { graceMs?: number }) => {
                calls.push(`stop:${options?.graceMs}`);
                if (stopBehaviour === 'rejects') throw new Error('supervisor gone');
                t.exit(PROVIDER); t.exit(SUPERVISOR);
                if (stopBehaviour === 'ends-tree') t.exit(MCP);
                return { graceful: true, empty: stopBehaviour === 'ends-tree', survivors: stopBehaviour === 'ends-tree' ? 0 : 1, verified: true };
            },
        }),
    };
    const dir = mkdtempSync(join(tmpdir(), 'genie2-prism021-'));
    dirs.push(dir);
    const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: () => driver, processTree: t.tree });
    s.start();
    t.spawn(MCP, PROVIDER, 'node.exe');
    return { t, s, calls };
}

describe('a graceful stop goes through the driver’s own stop (prism-acp 0.21.1)', () => {
    it('stop({ graceMs }) once — not endInput, not a kill — and Genie’s reading verifies nothing of the run is left', async () => {
        const h = harness('ends-tree');
        const verdict = await h.s.stop('SIGTERM', { graceMs: 3_000 });
        expect(h.calls.filter((c) => c.startsWith('stop'))).toEqual(['stop:3000']);
        expect(h.calls).not.toContain('endInput');
        expect(verdict).toMatchObject({ verified: true });
        // Prism ended it: Genie killed nothing itself, and the sibling (another agent's helper) is untouched.
        expect(h.t.killsOf(PROVIDER) + h.t.killsOf(MCP) + h.t.killsOf(SUPERVISOR)).toBe(0);
        expect(h.t.alive(SIBLING)).toBe(true);
    });

    it('a process the driver’s stop left behind is reaped by Genie, and only then is the stop verified', async () => {
        const h = harness('leaves-one');
        const verdict = await h.s.stop('SIGTERM', { graceMs: 3_000 });
        expect(h.t.alive(MCP)).toBe(false);
        expect(h.t.killsOf(MCP)).toBe(1);
        expect(verdict).toMatchObject({ verified: true });
        expect(h.t.alive(SIBLING)).toBe(true);
    });

    it('a driver stop that fails still ends the run: the kill and Genie’s reap, verified by the reading', async () => {
        const h = harness('rejects');
        const verdict = await h.s.stop('SIGTERM', { graceMs: 3_000 });
        expect(h.calls).toContain('kill');
        for (const pid of [SUPERVISOR, PROVIDER, MCP]) expect(h.t.alive(pid), `pid ${pid}`).toBe(false);
        expect(verdict).toMatchObject({ verified: true });
    });
});

describe('the paths that do not change', () => {
    it('no grace (quit, upgrade): the kill, synchronously — the driver’s async stop is not used', () => {
        const h = harness('ends-tree');
        void h.s.stop('SIGTERM', { graceMs: 0 });
        expect(h.calls).toEqual(['kill']);
        expect(h.t.alive(PROVIDER)).toBe(false);
        expect(h.t.alive(MCP)).toBe(false);
    });

    it('CONTROL: a driver without stop (a fake, an older prism) keeps stdin-then-kill', async () => {
        const h = harness('none');
        const verdict = await h.s.stop('SIGTERM', { graceMs: 50 });
        expect(h.calls).toEqual(['endInput', 'kill']);
        expect(verdict).toMatchObject({ verified: true });
    });
});

describe('the supervisor is prepared at start-up, in Genie’s own runtime folder', () => {
    const main = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('prepareProcessTree({ directory }) under Genie’s runtime dir; a failure is logged and said, never swallowed', () => {
        expect(main).toMatch(/prepareProcessTree\(\{ directory: join\(runtimeDir\(genieHome\(\)\), 'prism-supervisor'\) \}\)/);
        expect(main).toMatch(/prepareProcessTree\([^;]*\)\.catch\(\(error: unknown\) => \{[\s\S]{0,400}lifecycleLog\(/);
    });
});

describe('a supervisor that cannot be prepared is on the Deck, in words', () => {
    it('titled as what it costs — agents cannot be stopped whole — not as a crash', async () => {
        const { MainErrorBook } = await import('../src/core/main-errors.js');
        const book = new MainErrorBook({ now: () => 0 });
        book.record('containment-unready', new Error('the C# compiler of .NET Framework 4 was not found'));
        const [item] = book.deckItems();
        expect(item?.title).toBe('Agents cannot start contained: the C# compiler of .NET Framework 4 was not found. Until this is fixed an agent will not start, so none is left running uncontained. Each step is in ~/.genie/runtime/lifecycle.log.');
    });
});
