import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentToGraph, graphToDocument } from '../src/core/flow-canvas.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE CANVAS SAVES THROUGH THE SAME DOOR AS EVERYONE (genie#1204 item 1). The editor window sends `flows.saveGraph`; main
 * checks it with the engine (the store's own door, which agents' `flows create` also pass) plus what only a save can know
 * — the workspaces and agents as they are now — and either stores it or answers the problems, each on its node, storing
 * nothing. Saving never arms. Saving a change to WHAT an armed flow does disarms it and says so, as Genie 1's
 * `flows:save` did (main/flows/ipc.ts:196-230, `changesConsent` :315-361 at v0.7.0-beta.342); moving a node does not.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
const roster = [{ id: 'agent_atlas', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null }] as unknown as AgentRecord[];
const opened: string[] = [];

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-flow-editor-'));
    opened.length = 0;
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, workspaces: () => [{ id: 'tynn', path: dir }] });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const canvas = (nodes: unknown[], edges: unknown[]) => graphToDocument(documentToGraph({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } }));
const report = (command = 'npm run report', x = 240) => canvas([n('t', 'schedule_trigger', { cron: '0 3 * * *' }), n('s', 'genie/terminal_run', { workspace: 'tynn', command }, x)], [{ id: 'e1', source: 't', target: 's' }]);
const ports = { openFlowEditor: (route: string) => { opened.push(route); } };

describe('saving from the canvas', () => {
    it('a new flow is created DISARMED, as the person, and the answer names it', async () => {
        const data = await handleFeatureAction(services, { kind: 'flows.saveGraph', workspaceId: 'tynn', name: 'nightly report', document: report() }, undefined, ports);
        expect(data.flows!.saved).toMatchObject({ ok: true, disarmed: false });
        const [flow] = services.flows.list();
        expect(flow).toMatchObject({ name: 'nightly report', workspaceId: 'tynn', armed: false, createdBy: { kind: 'user' } });
        expect((data.flows!.saved as { flowId: string }).flowId).toBe(flow!.id);
        expect(services.flows.schedules(flow!.id)).toEqual([{ nodeId: 't', cron: '0 3 * * *', timezone: undefined }]);
    });

    it('a flow that cannot run is NOT stored, and each problem comes back on its node', async () => {
        const bad = canvas([n('t', 'schedule_trigger', { cron: 'every day' }), n('s', 'genie/terminal_run', { workspace: 'tynn' }, 240), n('a', 'genie/agent_prompt', { agent: 'ghost', prompt: 'hi' }, 480)], [{ id: 'e1', source: 't', target: 's' }, { id: 'e2', source: 's', target: 'a' }]);
        const data = await handleFeatureAction(services, { kind: 'flows.saveGraph', workspaceId: 'tynn', name: 'broken', document: bad }, undefined, ports);
        expect(data.flows!.saved).toMatchObject({ ok: false });
        const problems = (data.flows!.saved as { problems: Array<{ nodeId?: string; message: string }> }).problems;
        expect(problems).toEqual(expect.arrayContaining([
            { nodeId: 't', message: expect.stringMatching(/"every day" is not a schedule/) },
            { nodeId: 's', message: expect.stringMatching(/command/i) },
            { nodeId: 'a', message: expect.stringMatching(/no agent answers to ghost/) },
        ]));
        expect(services.flows.list()).toEqual([]);
    });

    it('a kind Genie cannot run is refused by the store’s door too — the one agents pass', async () => {
        await expect(services.flows.create({ workspaceId: 'tynn', name: 'hook', document: canvas([n('t', 'manual_trigger'), n('w', 'webhook_out', { url: 'https://example.com' }, 240)], [{ id: 'e', source: 't', target: 'w' }]), by: { kind: 'agent', id: 'agent_atlas', name: 'atlas' } })).rejects.toThrow(/node w: .*is not a step Genie can run/);
    });

    it('saving never arms; changing what an ARMED flow does disarms it and says so; moving a node does not', async () => {
        const made = await handleFeatureAction(services, { kind: 'flows.saveGraph', workspaceId: 'tynn', name: 'nightly', document: report() }, undefined, ports);
        const id = (made.flows!.saved as { flowId: string }).flowId;
        await handleFeatureAction(services, { kind: 'flows.arm', flowId: id });

        const moved = await handleFeatureAction(services, { kind: 'flows.saveGraph', flowId: id, workspaceId: 'tynn', name: 'nightly', document: report('npm run report', 600) }, undefined, ports);
        expect(moved.flows!.saved).toMatchObject({ ok: true, disarmed: false });
        expect(services.flows.get(id)!.armed).toBe(true);

        const renamed = await handleFeatureAction(services, { kind: 'flows.saveGraph', flowId: id, workspaceId: 'tynn', name: 'nightly report', document: report('npm run report', 600) }, undefined, ports);
        expect(renamed.flows!.saved).toMatchObject({ ok: true, disarmed: false });
        expect(services.flows.get(id)).toMatchObject({ armed: true, name: 'nightly report' });

        const changed = await handleFeatureAction(services, { kind: 'flows.saveGraph', flowId: id, workspaceId: 'tynn', name: 'nightly report', document: report('rm -rf build') }, undefined, ports);
        expect(changed.flows!.saved).toMatchObject({ ok: true, disarmed: true });
        expect(services.flows.get(id)!.armed).toBe(false);
    });

    it('opening a flow, or a new one, asks for the editor window on its route', async () => {
        await handleFeatureAction(services, { kind: 'flows.openEditor', flowId: 'flow_abc' }, undefined, ports);
        await handleFeatureAction(services, { kind: 'flows.newFlow', workspaceId: 'tynn' }, undefined, ports);
        expect(opened).toEqual(['genie://flow/flow_abc', 'genie://flow/new?workspace=tynn']);
    });
});
