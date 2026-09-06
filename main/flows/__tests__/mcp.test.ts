import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../db';
import { handleManageFlows, type ManageFlowsDeps } from '../mcp';
import { registerGenieKinds } from '../kinds';
import { registerEventTriggerKind } from '../event-trigger';
import { createFlowEventRegistry } from '../events';
import { getFlowIn, listFlowsIn, setFlowEnabledIn, upsertFlowIn } from '../store';
import { PAUSES_WITHOUT_RESUME } from '../refusals';

/**
 * How an AGENT authors a flow.
 *
 * Genie's flows will mostly be written by agents, so this is not a footnote —
 * it is the half of the feature that did not exist. Phase 1 of genie#394
 * shipped a complete flow model that nothing in Genie could create.
 *
 * `fancy-flow-mcp` does exactly this job and is Laravel-only (`composer
 * require`, no npm path), so Genie builds the surface itself over the engine
 * primitives it already has — `getNodeKind`, `defaultConfigFor`,
 * `validateConfig`, `checkGraphConnectivity`, and `decideFlowAdmission`.
 *
 * ## The one rule that is not convenience
 *
 * **An agent may save and check a flow. It may never ARM one.**
 *
 * Arming hands a flow standing permission to act unattended. An agent that can
 * arm its own flow can grant itself standing permission that nobody agreed to,
 * and can do it at 3am in a terminal nobody is watching — which is the exact
 * shape of the thing arming exists to gate. So `enable` refuses and points at
 * the surface that asks a person.
 */

let db: Database.Database;

beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    registerGenieKinds();
    registerEventTriggerKind(createFlowEventRegistry());
});

const deps = (over: Partial<ManageFlowsDeps> = {}): ManageFlowsDeps => ({
    db,
    workspaceId: () => 'ws-1',
    loadGrant: () => null,
    run: vi.fn(async () => ({ ok: true as const })),
    ...over,
});

const call = (args: Record<string, unknown>, over: Partial<ManageFlowsDeps> = {}) =>
    handleManageFlows(args, deps(over));

function seed(id: string, title = id): void {
    upsertFlowIn(db, {
        id,
        title,
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        graph: { nodes: [], edges: [] },
    });
}

describe('an agent can see what it may build with', () => {
    it('lists the flows in its own workspace', async () => {
        seed('mine');
        upsertFlowIn(db, {
            id: 'theirs',
            title: 'Theirs',
            scope: { kind: 'workspace', workspaceId: 'ws-OTHER' },
            graph: {},
        });

        const out = await call({ action: 'list' });

        expect(out.flows?.map((f) => f.id)).toEqual(['mine']);
    });

    it('offers the node kinds, so it does not have to guess a name', async () => {
        const out = await call({ action: 'nodes' });

        const kinds = out.nodes?.map((n) => n.kind) ?? [];
        expect(kinds).toContain('@genie/manageTerminals');
        expect(kinds).toContain('@particle-academy/branch');
        // Not a name it could invent: an ungrantable tool has no kind at all.
        expect(kinds).not.toContain('@genie/submitFeedback');
    });

    it('gives each node its config fields, so a call can be written blind', async () => {
        const out = await call({ action: 'nodes' });
        const terminals = out.nodes?.find((n) => n.kind === '@genie/manageTerminals');

        expect(terminals?.config?.some((f) => f.key === 'action')).toBe(true);
    });
});

describe('checking before saving', () => {
    it('reports what a graph would be refused for, without storing anything', async () => {
        const out = await call({
            action: 'check',
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
            graph: {
                nodes: [
                    {
                        id: 'a',
                        type: '@genie/manageSite',
                        data: { kind: '@genie/manageSite', config: { workspaceId: 'ws-OTHER' } },
                    },
                ],
                edges: [],
            },
        });

        expect(out.allowed).toBe(false);
        expect(out.refusals?.[0]?.nodeId).toBe('a');
        expect(listFlowsIn(db)).toEqual([]);
    });

    it('says yes to a graph that stays inside its workspace', async () => {
        const out = await call({
            action: 'check',
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
            graph: {
                nodes: [
                    { id: 'a', type: '@genie/manageSite', data: { kind: '@genie/manageSite', config: {} } },
                ],
                edges: [],
            },
        });

        expect(out.allowed, JSON.stringify(out.refusals)).toBe(true);
    });
});

describe('saving', () => {
    it('creates a flow in the agent’s own workspace by default', async () => {
        const out = await call({ action: 'save', title: 'Nightly', graph: { nodes: [], edges: [] } });

        expect(out.flow?.id).toBeTruthy();
        expect(getFlowIn(db, out.flow!.id)!.scope).toEqual({
            kind: 'workspace',
            workspaceId: 'ws-1',
        });
    });

    it('creates it DISARMED, and there is no field to ask otherwise', async () => {
        const out = await call({
            action: 'save',
            title: 'Nightly',
            graph: { nodes: [], edges: [] },
            // A hand-written payload trying the obvious thing.
            enabled: true,
        });

        expect(getFlowIn(db, out.flow!.id)!.enabled).toBe(false);
    });

    it('updates an existing flow in place', async () => {
        seed('f1', 'Before');
        await call({ action: 'save', flowId: 'f1', title: 'After', graph: { nodes: [], edges: [] } });

        expect(listFlowsIn(db)).toHaveLength(1);
        expect(getFlowIn(db, 'f1')!.title).toBe('After');
    });

    it('refuses to touch a flow outside its workspace', async () => {
        upsertFlowIn(db, {
            id: 'theirs',
            title: 'Theirs',
            scope: { kind: 'workspace', workspaceId: 'ws-OTHER' },
            graph: {},
        });

        const out = await call({ action: 'save', flowId: 'theirs', title: 'Mine now', graph: {} });

        expect(out.error).toMatch(/cannot see/i);
        expect(getFlowIn(db, 'theirs')!.title).toBe('Theirs');
    });

    it('refuses a machine-wide scope — that is a person’s decision', async () => {
        // An agent widening its own reach from "this workspace" to "everything"
        // is the same escalation as arming, one step earlier.
        const out = await call({
            action: 'save',
            title: 'Everywhere',
            scope: { kind: 'system' },
            graph: {},
        });

        expect(out.error).toMatch(/whole machine/i);
        expect(listFlowsIn(db)).toEqual([]);
    });

    it('saves a graph that would be REFUSED, because an author may be mid-edit', async () => {
        // Saving is not authorising. A canvas that refused to save an unfinished
        // flow would be unusable, and an agent gets the same latitude — with the
        // refusals handed back so it knows.
        const out = await call({
            action: 'save',
            title: 'Reaching',
            graph: {
                nodes: [
                    {
                        id: 'a',
                        type: '@genie/manageSite',
                        data: { kind: '@genie/manageSite', config: { workspaceId: 'ws-OTHER' } },
                    },
                ],
                edges: [],
            },
        });

        expect(out.flow).toBeTruthy();
        expect(out.allowed).toBe(false);
        expect(out.refusals?.length).toBeGreaterThan(0);
    });
});

describe('an agent may NEVER arm a flow', () => {
    it('refuses `enable`, and says who can', async () => {
        seed('f1');
        const out = await call({ action: 'enable', flowId: 'f1' });

        expect(out.error).toMatch(/ForceTheQuestion|ask the user/i);
        expect(getFlowIn(db, 'f1')!.enabled).toBe(false);
    });

    it('refuses it even for a flow that is already on', async () => {
        upsertFlowIn(db, {
            id: 'on',
            title: 'On',
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
            graph: {},
            enabled: true,
        });

        await call({ action: 'enable', flowId: 'on' });
        expect(getFlowIn(db, 'on')!.enabled).toBe(true);
    });

    it('DOES let it turn one off — the machine doing less needs no permission', async () => {
        upsertFlowIn(db, {
            id: 'on',
            title: 'On',
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
            graph: {},
            enabled: true,
        });

        const out = await call({ action: 'disable', flowId: 'on' });

        expect(out.error).toBeUndefined();
        expect(getFlowIn(db, 'on')!.enabled).toBe(false);
    });
});

describe('running one by hand', () => {
    /**
     * "By hand" means BY A HUMAN.
     *
     * A disarmed flow can be run by hand — that is how you try one before
     * arming it, and it is safe because a person pressing Run is present, and
     * the attendance IS the consent. An agent calling `run` is not that. If it
     * could run a disarmed flow, the whole arming gate would have a door beside
     * it: author a flow, never ask anyone, run it whenever you like.
     *
     * So an agent may only run a flow a person has already armed.
     */
    it('runs a flow its workspace has ARMED', async () => {
        upsertFlowIn(db, {
            id: 'f1',
            title: 'f1',
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
            graph: { nodes: [], edges: [] },
            enabled: true,
        });
        const run = vi.fn(async () => ({ ok: true as const }));

        await call({ action: 'run', flowId: 'f1' }, { run });

        expect(run).toHaveBeenCalledWith('f1');
    });

    it('REFUSES a disarmed flow — that is the arming gate, from the side', async () => {
        seed('off');
        const run = vi.fn(async () => ({ ok: true as const }));

        const out = await call({ action: 'run', flowId: 'off' }, { run });

        expect(out.error).toMatch(/not turned on|armed|ForceTheQuestion/i);
        expect(run).not.toHaveBeenCalled();
    });

    it('refuses to run one it cannot see', async () => {
        upsertFlowIn(db, {
            id: 'theirs',
            title: 'Theirs',
            scope: { kind: 'workspace', workspaceId: 'ws-OTHER' },
            graph: {},
        });
        const run = vi.fn(async () => ({ ok: true as const }));

        const out = await call({ action: 'run', flowId: 'theirs' }, { run });

        expect(out.error).toMatch(/cannot see/i);
        expect(run).not.toHaveBeenCalled();
    });
});

describe('deleting', () => {
    it('removes one in its workspace', async () => {
        seed('f1');
        await call({ action: 'delete', flowId: 'f1' });
        expect(getFlowIn(db, 'f1')).toBeNull();
    });

    it('refuses one it cannot see', async () => {
        upsertFlowIn(db, {
            id: 'theirs',
            title: 'Theirs',
            scope: { kind: 'workspace', workspaceId: 'ws-OTHER' },
            graph: {},
        });
        await call({ action: 'delete', flowId: 'theirs' });
        expect(getFlowIn(db, 'theirs')).not.toBeNull();
    });
});

describe('an agent with no workspace', () => {
    it('can do nothing, rather than acting machine-wide', async () => {
        const out = await call({ action: 'list' }, { workspaceId: () => null });

        expect(out.error).toMatch(/workspace/i);
    });
});

/**
 * The door an AGENT writes a flow through, for a step the canvas no longer offers.
 *
 * fancy-flow 0.66.0 gave `<FlowEditor>` a `kindFilter`, so Genie now hides every
 * refused kind from the palette, so a person cannot drag on a node that would
 * hang or fail the run. An agent does not use the palette. It writes a
 * graph and posts it HERE — hand-authored, imported, or copied from a doc — and
 * a filter over a sidebar can never see that.
 *
 * So the refusal has to stand at this door whatever the canvas offers, and these
 * assert it was not quietly dropped once the palette started hiding them. They
 * are driven off `PAUSES_WITHOUT_RESUME` rather than three literals for the same
 * reason the filter is: one list, or the two halves drift.
 */
describe('a pause step the palette no longer offers', () => {
    const pauseGraph = (kind: string) => ({
        nodes: [{ id: 'h', type: kind, data: { kind, config: {} } }],
        edges: [],
    });

    it.each([...PAUSES_WITHOUT_RESUME])('is refused when an agent CHECKS %s', async (kind) => {
        const out = await call({ action: 'check', graph: pauseGraph(kind) });

        expect(out.allowed).toBe(false);
        expect(out.refusals?.[0]?.nodeId).toBe('h');
        expect(out.refusals?.[0]?.reason).toMatch(/cannot resume a paused flow/);
    });

    it.each([...PAUSES_WITHOUT_RESUME])('SAVES %s but refuses it, so the author is told', async (kind) => {
        // Saving is not authorising — an author may be mid-edit — so the flow
        // is stored and the reason comes back with it. A save that succeeded
        // SILENTLY would be the trap wearing a different hat.
        const out = await call({ action: 'save', title: 'Waits', graph: pauseGraph(kind) });

        expect(out.flow).toBeTruthy();
        expect(out.allowed).toBe(false);
        expect(out.refusals?.[0]?.reason).toMatch(/cannot resume a paused flow/);
    });

    it('CONTROL: the same door admits a step Genie does run', async () => {
        // Without this, a door that refused EVERYTHING would pass the above.
        const out = await call({
            action: 'check',
            graph: {
                nodes: [
                    {
                        id: 'q',
                        type: '@genie/ForceTheQuestion',
                        data: { kind: '@genie/ForceTheQuestion', config: {} },
                    },
                ],
                edges: [],
            },
        });

        expect(out.allowed, JSON.stringify(out.refusals)).toBe(true);
    });
});

/**
 * The green `!` on the workspace row: an AGENT ran a flow by hand.
 *
 * Marked HERE, at the MCP layer, and not inside the runner — a person running a
 * flow from the Flow Manager goes through the same runner, and the marker is
 * about agent behaviour. Marking in the shared runner would light the row for
 * the user's own click.
 *
 * The arming gate is untouched by any of this. An agent still cannot run a
 * disarmed flow, and the test below is what proves the marker does not sneak
 * past that refusal.
 */
describe('a hand-run flow marks the workspace row', () => {
    it('marks after the run actually STARTS', async () => {
        seed('armed');
        setFlowEnabledIn(db, 'armed', true);
        const markRan = vi.fn();

        const out = await call({ action: 'run', flowId: 'armed' }, { markRan });

        expect(out.ok).toBe(true);
        expect(markRan).toHaveBeenCalledWith('ws-1');
    });

    it('does NOT mark when the runner refuses to start it', async () => {
        seed('armed');
        setFlowEnabledIn(db, 'armed', true);
        const markRan = vi.fn();

        await call(
            { action: 'run', flowId: 'armed' },
            { markRan, run: vi.fn(async () => ({ ok: false as const, error: 'engine down' })) },
        );

        // Nothing ran, so nothing happened to draw.
        expect(markRan).not.toHaveBeenCalled();
    });

    it('does NOT mark a DISARMED flow — the arming gate still refuses first', async () => {
        seed('disarmed');
        const markRan = vi.fn();
        const run = vi.fn(async () => ({ ok: true as const }));

        const out = await call({ action: 'run', flowId: 'disarmed' }, { markRan, run });

        expect(out.error).toMatch(/not turned on/i);
        expect(run).not.toHaveBeenCalled();
        expect(markRan).not.toHaveBeenCalled();

        // Positive control: arm the SAME flow and both fire, so the two absences
        // above are the gate refusing and not a marker that never works.
        setFlowEnabledIn(db, 'disarmed', true);
        await call({ action: 'run', flowId: 'disarmed' }, { markRan, run });
        expect(run).toHaveBeenCalled();
        expect(markRan).toHaveBeenCalledWith('ws-1');
    });

    it('marks nothing for an agent with no workspace', async () => {
        seed('armed');
        setFlowEnabledIn(db, 'armed', true);
        const markRan = vi.fn();

        await call({ action: 'run', flowId: 'armed' }, { markRan, workspaceId: () => null });

        expect(markRan).not.toHaveBeenCalled();
    });
});
