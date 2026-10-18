import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_KINDS, SOUND_GROUPS, alertSound } from '../src/core/alerts.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { ThingSounds, flowRunSound } from '../src/core/thing-sounds.js';
import { FlowStore } from '../src/main/flow-store.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import { ServiceDriver } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * A SOUND FOR WHAT AGENTS RUN (Tynn #766 row C2b; the owner, 2026-10-17: "Every kind of action an agent can take needs to
 * have a sound setting"). Processes, sites, services and flows are what agents start through Genie; each change a person
 * would want to hear about is its own row under "Things it runs", None until chosen:
 *  - a process EXITS (it was running, and it exited or failed) — a site's own server is the site's row, not this one;
 *  - a site goes DOWN (it was running and exited or failed; a stop you asked for is not "down") or comes back UP (running
 *    again after going down; Genie starting it at boot, or you starting it, is not news);
 *  - a service is STARTED (added, or started again);
 *  - a flow FINISHES a run (it ran, or it failed; a run held back never ran).
 * The first thing Genie sees after a boot is a baseline, never a sound (Genie 1's rule): nobody hears a site come up
 * because Genie restarted.
 */
const kinds = ['exits', 'siteup', 'sitedown', 'serviceup', 'flowdone'] as const;

describe('the rows', () => {
    it('five kinds under "Things it runs", each None until chosen, each playing once chosen', () => {
        expect(SOUND_GROUPS.map((g) => g.group)).toContain('things');
        expect(SOUND_GROUPS.find((g) => g.group === 'things')!.label).toBe('Things it runs');
        expect(ALERT_KINDS.filter((k) => k.group === 'things').map((k) => k.kind)).toEqual([...kinds]);
        for (const k of kinds) {
            expect(alertSound(k, { notification_sounds: true }), k).toBeNull();
            expect(alertSound(k, { notification_sounds: true, [`sound_${k}`]: 'sparkle' }), k).toEqual({ kind: 'wav', file: 'sparkle.wav' });
        }
        expect(ALERT_KINDS).toHaveLength(26);
    });
});

describe('processes', () => {
    it('running → exited or failed is an exit; COUNTED over a life: started, exited, restarted, failed', () => {
        const t = new ThingSounds();
        const heard = [
            t.process({ id: 'p1', state: 'running' }, false),
            t.process({ id: 'p1', state: 'exited' }, false),
            t.process({ id: 'p1', state: 'restarting' }, false),
            t.process({ id: 'p1', state: 'running' }, false),
            t.process({ id: 'p1', state: 'failed' }, false),
        ];
        expect(heard).toEqual([null, 'exits', null, null, 'exits']);
    });

    it('not an exit: a stop you asked for, an exit never seen running, the same state twice, a site’s own server', () => {
        const t = new ThingSounds();
        t.process({ id: 'p1', state: 'running' }, false);
        expect(t.process({ id: 'p1', state: 'stopped' }, false)).toBeNull();
        expect(t.process({ id: 'p2', state: 'exited' }, false)).toBeNull();
        t.process({ id: 'p3', state: 'running' }, false);
        expect(t.process({ id: 'p3', state: 'running' }, false)).toBeNull();
        t.process({ id: 'p4', state: 'running' }, true);
        expect(t.process({ id: 'p4', state: 'exited' }, true)).toBeNull();
    });
});

describe('sites', () => {
    it('the first list is a baseline; down when a running one exits or fails, back up when it runs again — COUNTED', () => {
        const t = new ThingSounds();
        expect(t.sites([{ id: 's1', state: 'running' }, { id: 's2', state: 'running' }])).toEqual([]);
        expect(t.sites([{ id: 's1', state: 'failed' }, { id: 's2', state: 'running' }])).toEqual(['sitedown']);
        expect(t.sites([{ id: 's1', state: 'running' }, { id: 's2', state: 'exited' }])).toEqual(['siteup', 'sitedown']);
        expect(t.sites([{ id: 's1', state: 'running' }, { id: 's2', state: 'running' }])).toEqual(['siteup']);
    });

    it('not news: Genie starting a site at boot, you starting or stopping one, a site added (CONTROL: then it fails)', () => {
        const t = new ThingSounds();
        // Boot: declared stopped, then started.
        expect(t.sites([{ id: 's1', state: 'stopped' }])).toEqual([]);
        expect(t.sites([{ id: 's1', state: 'running' }])).toEqual([]);
        expect(t.sites([{ id: 's1', state: 'stopped' }])).toEqual([]);
        expect(t.sites([{ id: 's1', state: 'stopped' }, { id: 's9', state: 'running' }])).toEqual([]);
        expect(t.sites([{ id: 's1', state: 'stopped' }, { id: 's9', state: 'failed' }])).toEqual(['sitedown']);
    });
});

describe('flows', () => {
    it('a run that ran or failed finishes; one held back never ran', () => {
        expect(flowRunSound({ outcome: 'ran' })).toBe('flowdone');
        expect(flowRunSound({ outcome: 'failed' })).toBe('flowdone');
        expect(flowRunSound({ outcome: 'held' })).toBeNull();
    });

    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-thing-sounds-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('the flow store tells its run listeners each run as it ends — COUNTED, with its outcome', async () => {
        const store = await FlowStore.open(dir, () => Date.UTC(2026, 9, 17));
        const doc = {
            $schema: FLOW_SCHEMA_URL,
            version: 1,
            graph: {
                nodes: [
                    { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '*/5 * * * *', timezone: 'UTC' } },
                    { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } },
                ],
                edges: [{ id: 'e1', source: 't', target: 'l' }],
            },
        };
        const flow = await store.create({ workspaceId: 'tynn', name: 'tick', document: doc, by: { kind: 'user' } });
        const runs: string[] = [];
        store.onRun((flowId, run) => { runs.push(`${flowId === flow.id ? 'it' : flowId}:${run.outcome}`); });
        await store.recordRun(flow.id, { trigger: 'manual', outcome: 'ran', startedAt: Date.UTC(2026, 9, 17) });
        await store.recordRun(flow.id, { trigger: 'schedule', outcome: 'held', reason: 'busy', startedAt: Date.UTC(2026, 9, 17) });
        await store.recordRun('flow_gone', { trigger: 'manual', outcome: 'ran', startedAt: Date.UTC(2026, 9, 17) });
        expect(runs).toEqual(['it:ran', 'it:held']);
    });
});

describe('services', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-thing-sounds-svc-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('the registry tells its listeners when an engine is started — added, or started again; not when stopped', async () => {
        const containers = new Map<string, string>();
        const run: DockerRunner = async (args) => {
            const [cmd, sub] = args;
            if (cmd === 'version') return { stdout: '28.1.0', exitCode: 0 };
            if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
            if (cmd === 'container' && sub === 'inspect') {
                const st = containers.get(args[2]!);
                return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
            }
            if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
            if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
            if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
            return { stdout: '', exitCode: 0 };
        };
        let port = 54400;
        const registry = await ServiceRegistry.open(dir, new ServiceDriver(run), { allocatePort: () => ++port, randomPassword: () => 'pw' });
        const started: string[] = [];
        registry.onStarted((id) => { started.push(id); });
        const r = await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true });
        const id = (r as { instance: { id: string } }).instance.id;
        await registry.stop(id);
        await registry.start(id);
        expect(started).toEqual([id, id]);
    });
});

describe('main reports them to the window that plays them', () => {
    const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('each source is wired to ONE ThingSounds and broadcast as a genie:action', () => {
        expect(src.match(/new ThingSounds\(\)/g)).toHaveLength(1);
        expect(src).toMatch(/composed\.supervisor\.onChange\(\(status\) => \{ const kind = things\.process\(status, siteProcess\(status\.id\)\); if \(kind\) broadcast\('genie:action', \{ agentId: null, kind \}\); \}\);/);
        expect(src).toMatch(/composed\.sites\.onChange\(\(\) => \{ for \(const kind of things\.sites\(composed\.sites\.list\(\)\)\) broadcast\('genie:action', \{ agentId: null, kind \}\); \}\);/);
        expect(src).toMatch(/composed\.engines\.onStarted\(\(\) => \{ broadcast\('genie:action', \{ agentId: null, kind: 'serviceup' \}\); \}\);/);
        expect(src).toMatch(/composed\.flows\.onRun\(\(_id, run\) => \{ const kind = flowRunSound\(run\); if \(kind\) broadcast\('genie:action', \{ agentId: null, kind \}\); \}\);/);
    });
});
