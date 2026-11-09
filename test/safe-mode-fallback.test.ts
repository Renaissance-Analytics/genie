import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { type SafeModeView } from '../src/core/safe-mode.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';
import type { PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { WindowSafeMode, type LinkSafeMode } from '../src/main/window-safe-mode.js';
import { windowWake } from '../src/main/window-wake.js';

/**
 * SAFE MODE ON THE EMERGENCY NO-HOST PATH (Tynn #386; the coordinator's ruling for beta.60). When genie-host cannot start,
 * this window runs the agents, flows, scheduled tasks, kept processes, sites and engines itself. A host that keeps
 * crashing falls back to that path every time — so it must honour safe mode too, or the loop the owner hit comes back
 * through the fallback. The state is read WITHOUT a host: the same runtime files, read by the window, which then also
 * writes the clean-exit marker at its own clean end (it is the run).
 *
 * Every path is a spy with a normal-mode control in this file.
 */

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const tempDir = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

// ─── the state, read by the window with no host ──────────────────────────────────────────────────────────────────────────

describe('the window reads genie-host’s safe mode', () => {
    it('the host’s view, the host’s Leave, and what the host says next', async () => {
        const hostView: SafeModeView = { active: true, at: 9, cause: 'unknown', crashLoop: false, agents: [], processes: [], sites: [] };
        let left = 0;
        let tell: (view: SafeModeView) => void = () => {};
        const link: LinkSafeMode = { safeModeView: () => hostView, leaveSafeMode: async () => { left += 1; return { ok: true }; }, onSafeMode: (l) => { tell = l; return () => {}; } };
        const mode = WindowSafeMode.open({ link });
        expect(mode.active()).toBe(true);
        expect(mode.view()).toBe(hostView);
        expect(await mode.leave()).toEqual({ ok: true });
        expect(left).toBe(1);
        const told: boolean[] = [];
        mode.onChange((v) => told.push(v.active));
        tell({ ...hostView, active: false });
        expect(told).toEqual([false]);
    });

    it('CONTROL: a host not yet heard is not safe mode', () => {
        const link: LinkSafeMode = { safeModeView: () => null, leaveSafeMode: async () => ({ ok: true }), onSafeMode: () => () => {} };
        expect(WindowSafeMode.open({ link }).active()).toBe(false);
    });
});

// ─── the window's own wake (mail and IssueWatch's push) ──────────────────────────────────────────────────────────────────

function wakeRig(safe: boolean) {
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas' });
    const started: string[] = [];
    const log: string[] = [];
    const wake = windowWake({
        safeMode: () => safe,
        find: (id) => (id === atlas.id ? atlas : null),
        running: () => false,
        refusal: () => null,
        start: async (r: AgentRecord) => { started.push(r.id); return true; },
        log: (l) => log.push(l),
    });
    return { atlas, wake, started, log };
}

describe('the window’s own wake', () => {
    it('SAFE MODE: mail or IssueWatch to a stopped agent starts nothing, and says why', async () => {
        const r = wakeRig(true);
        expect(await r.wake(r.atlas.id)).toBe(false);
        expect(r.started).toEqual([]);
        expect(r.log.join('\n')).toMatch(/safe mode/i);
    });

    it('CONTROL, normal mode: it starts the agent', async () => {
        const r = wakeRig(false);
        expect(await r.wake(r.atlas.id)).toBe(true);
        expect(r.started).toEqual([r.atlas.id]);
    });
});

// ─── compose's own flows and sites (the window's hosting, with no host) ──────────────────────────────────────────────────

function scriptedPty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(o) { const id = `pty_${++n}`; opened.push({ ...o, id }); return { id, pid: 8000 + n, shell: 'sh', scrollback: '' }; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    return { port, opened };
}
const scheduleDoc = {
    $schema: FLOW_SCHEMA_URL, version: 1,
    graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } }, { id: 'l', kind: 'log', position: { x: 240, y: 0 }, config: { message: 'tick' } }], edges: [{ id: 'e1', source: 't', target: 'l' }] },
};
const site = { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'shop', genName: 'shop.gen', command: ['npm', 'run', 'dev', '--', '--port', '5173'] };

async function composeRig(safe: boolean) {
    const dir = tempDir('fallback-compose-');
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'repos', 'shop'), { recursive: true });
    writeFileSync(join(ws, 'project.json'), JSON.stringify({ $schema: 'https://example.invalid/project.schema.json', name: 'Acme', repos: [{ name: 'shop', slug: 'shop', path: 'repos/shop' }], sites: { k1: site } }));
    // The run before this one left a flow armed on a schedule, and a run of it interrupted.
    const before = await FlowStore.open(dir);
    const armed = await before.create({ workspaceId: 'ws-example', name: 'nightly', document: scheduleDoc, by: { kind: 'user' }, armed: true });
    // RESUMABLE (flow-store.ts `resumable`): the trigger ran and left its output, the log step was running — a store that
    // opens on anything else records it stopped and there would be nothing to resume.
    await before.markInFlight(armed.id, { at: new Date().toISOString(), trigger: 'manual', nodes: { t: 'ran', l: 'running' }, outputs: { t: {} }, entry: 't' });
    const pty = scriptedPty();
    const held: string[] = [];
    let leftListener: (() => void) | null = null;
    // As WindowSafeMode reads it: on until the person leaves it.
    let on = safe;
    const services: ComposedServices = await composeServices({
        userData: dir,
        pty: pty.port,
        v1Settings: () => null,
        caddyBin: null,
        frontDoorPort: 0,
        roster: () => [],
        workspaces: () => [{ id: 'ws-example', path: ws }],
        safeMode: () => on,
        heldSite: (siteId) => { held.push(siteId); },
        safeModeLeft: (listener) => { leftListener = listener; },
    });
    cleanups.push(() => services.shutdown());
    const scheduler = services.flowScheduler as unknown as FlowScheduler;
    await settle();
    await scheduler.settled();
    return { services, scheduler, pty, held, armedId: armed.id, leave: () => { on = false; leftListener?.(); } };
}
const devServers = (opened: ReadonlyArray<{ command?: string | undefined }>) => opened.filter((o) => (o.command ?? '').includes('npm run dev'));

describe('compose’s own flows and sites (no host)', () => {
    it('SAFE MODE: no flow is armed, the interrupted run is kept, the site stays down (named as held)', async () => {
        const r = await composeRig(true);
        expect(r.scheduler.nextDue()).toBeNull();
        expect(r.services.flows.get(r.armedId)?.inFlight).toBeDefined();
        expect(devServers(r.pty.opened)).toEqual([]);
        expect(r.held).toEqual(['site_shop']);
    });

    it('SAFE MODE, then Leave: the flow clock plans again, and nothing is started by the leave', async () => {
        const r = await composeRig(true);
        r.leave();
        expect(r.scheduler.nextDue()).toMatchObject({ flowId: r.armedId });
        await settle();
        expect(devServers(r.pty.opened)).toEqual([]);
    });

    it('CONTROL, normal mode: the flow is armed, the interrupted run resumes, the site is started', async () => {
        const r = await composeRig(false);
        expect(r.scheduler.nextDue()).toMatchObject({ flowId: r.armedId });
        expect(r.services.flows.get(r.armedId)?.inFlight).toBeUndefined();
        // It really RESUMED (not recorded stopped at open): the run is marked resumed.
        expect(r.services.flows.get(r.armedId)?.runs.at(-1)).toMatchObject({ resumed: true });
        expect(devServers(r.pty.opened)).toHaveLength(1);
        expect(r.held).toEqual([]);
    });
});

// ─── main.ts on the no-host path: every own clock and restore asks the window's safe mode ────────────────────────────────

describe('main.ts reads genie-host’s safe mode', () => {
    const main = readFileSync(resolve('src/main/main.ts'), 'utf8');
    const code = main.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

    it('opens it from the link, after the link is known and before anything is composed', () => {
        const opened = code.indexOf('WindowSafeMode.open({ link: agentEngineLink.client })');
        expect(opened).toBeGreaterThan(code.indexOf('agentEngineLink = await connectAgentEngine('));
        expect(opened).toBeLessThan(code.indexOf('composeWindowServices('));
    });

    it('the own process book and scheduler, the boot restore, the wake and compose all read it', () => {
        const fallback = code.slice(code.indexOf('const ownBook = await ProcessBook.open('), code.indexOf('processScheduler = ownScheduler;'));
        expect(fallback.match(/safeMode: windowSafeNow,/g) ?? []).toHaveLength(2);
        expect(code).toMatch(/restoreAfterRelaunch\(\{\s*safeMode: windowSafeNow,/);
        expect(code).toMatch(/const wakeAgent = windowWake\(\{\s*safeMode: windowSafeNow,/);
        expect(code).toMatch(/composeWindowServices\(\{[\s\S]{0,4000}safeMode: windowSafeNow,/);
    });

    it('the window never writes the marker: it is the host’s', () => {
        expect(code).not.toContain('endCleanly');
        expect(code).not.toContain('writeCleanExit');
    });
});
