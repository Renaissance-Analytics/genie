import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriver } from '../src/core/session.js';
import { processTable } from './support/process-table.js';

/*
 * Tynn #575, the line: prism-acp's supervisor reports what a stop found (`onStopVerdict`). When it confirmed the count itself
 * and nothing of the tree is left, Genie's own pid sweep has nothing to add. Only then: an unobserved count (a killed
 * supervisor) or survivors still get the sweep.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const SELF = process.pid, SUPERVISOR = 930_001, PROVIDER = 930_002, TOOL = 930_003, SIBLING = 930_100;
type Native = { graceful: boolean; empty: boolean; survivors: number | null; verified: boolean };

/** A tree whose TOOL is still in the table, so a sweep is visible: the driver's verdict alone says whether one is needed. */
function world(native: Native | null, how: 'event' | 'returned') {
    const t = processTable(SELF);
    t.spawn(SIBLING, SELF, 'fancy-pty-helper.exe');
    let events: DriverEvents = {};
    const driver: SessionDriver = {
        start: () => { t.spawn(SUPERVISOR, SELF, 'prism-acp-supervisor.exe'); t.spawn(PROVIDER, SUPERVISOR, 'claude.exe'); },
        prompt: () => {},
        kill: () => {},
        cliSessionId: null,
        stop: async () => {
            t.exit(PROVIDER); t.exit(SUPERVISOR);
            if (native === null) throw new Error('supervisor gone');
            if (how === 'event') { (events as { onStopVerdict?: (v: Native) => void }).onStopVerdict?.(native); return undefined; }
            return native;
        },
    };
    const dir = mkdtempSync(join(tmpdir(), 'genie-stop-verdict-')); dirs.push(dir);
    const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), processTree: t.tree, driverFactory: (options) => { events = options.events; return driver; } });
    s.start();
    t.spawn(TOOL, PROVIDER, 'bash.exe');
    return { t, s };
}
const clean: Native = { graceful: true, empty: true, survivors: 0, verified: true };

describe("the supervisor's own verdict", () => {
    it.each(['event', 'returned'] as const)('verified and empty (%s): Genie sweeps nothing and the stop is verified', async (how) => {
        const { t, s } = world(clean, how);
        const verdict = await s.stop('SIGTERM', { graceMs: 1_000 });
        expect(verdict).toMatchObject({ verified: true });
        expect(t.kills()).toEqual([]);
    });

    it('CONTROL: an empty tree nobody counted (a killed supervisor) still gets the sweep', async () => {
        const { t, s } = world({ graceful: false, empty: true, survivors: null, verified: false }, 'event');
        await s.stop('SIGTERM', { graceMs: 1_000 });
        expect(t.killsOf(TOOL)).toBe(1);
    });

    it('CONTROL: survivors still get the sweep', async () => {
        const { t, s } = world({ graceful: false, empty: false, survivors: 2, verified: true }, 'event');
        await s.stop('SIGTERM', { graceMs: 1_000 });
        expect(t.killsOf(TOOL)).toBe(1);
    });

    it('CONTROL: a stop that failed, with no verdict, still gets the sweep; another agent is never touched', async () => {
        const { t, s } = world(null, 'event');
        await s.stop('SIGTERM', { graceMs: 1_000 });
        expect(t.killsOf(TOOL)).toBe(1);
        expect(t.killsOf(SIBLING)).toBe(0);
    });

    it('is wired: the real drivers hand it to the session', () => {
        expect(readFileSync(new URL('../src/main/session-host.ts', import.meta.url), 'utf8')).toMatch(/onStopVerdict: \(verdict\) => events\.onStopVerdict\?\.\(verdict\)/);
    });
});
