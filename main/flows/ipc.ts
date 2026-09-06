/**
 * ONE IPC namespace for ONE flow system.
 *
 * Genie used to have two, because it had two systems: `flows:*` for the recipe
 * engine and `gapp-flows:*` for the canvas. There is one system now, and a
 * GApp's flow is a flow whose scope is `gapp` — so there is one namespace, and
 * every surface asks the same questions of it.
 *
 * ## Scope is a PARAMETER, not a separate channel
 *
 * `flows:list` takes a vantage: the machine, a workspace, or an app. A GApp
 * window asks for its own and gets its own; the Flow Manager asks for the
 * machine and gets everything. Two channels would have meant two answers to
 * "which flows are there", and eventually two different ones.
 *
 * ## Saving is not arming
 *
 * A graph reaching past what its scope allows SAVES perfectly happily — an
 * author is allowed to be mid-edit, and a canvas that refused to save an
 * unfinished flow would be unusable. `flows:check` is how that is shown while it
 * is being made rather than at 3am on the first scheduled fire.
 *
 * Arming is `flows:set-enabled`, and it is deliberately its own call rather than
 * a field on save: it hands the flow standing permission to act unattended, and
 * that decision must not ride along inside an edit.
 */

import { ipcMain } from 'electron';
import type { ServerDeps } from '../mcp/server';
import { decideFlowAdmission } from './admission';
import { authorityForScope } from './authority';
import { genieNodeDefinitions } from './kinds';
import { starterFlowGraph } from './graph';
import {
    flowEventRegistry,
    flowRunnerDeps,
    pushFlowsChanged,
    reconcileFlowWatches,
    runFlowManually,
} from './index';
import { genieNodeKind, listGenieNodeKinds, paletteForCapabilities } from './nodes';
import { listFlowRuns, lastFlowRuns } from './run-store';
import { reconcileFlowSchedules } from './scheduler';
import {
    deleteFlow,
    getFlow,
    listFlowsVisibleTo,
    setFlowEnabled,
    upsertFlow,
    type FlowRow,
} from './store';
import { declaredTriggers } from './triggers';
import { parseFlowScope, type FlowScope } from './types';
import { getAppGrant } from '../db';
import type { AppGrant } from '../apps/bridge-decision';

/** Where a caller is asking FROM. Decides which flows it may see. */
type Vantage =
    | { kind: 'system' }
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'gapp'; appId: string };

function readVantage(raw: unknown): Vantage {
    const v = (raw ?? {}) as { kind?: unknown; workspaceId?: unknown; appId?: unknown };
    if (v.kind === 'gapp' && typeof v.appId === 'string') return { kind: 'gapp', appId: v.appId };
    if (v.kind === 'workspace' && typeof v.workspaceId === 'string') {
        return { kind: 'workspace', workspaceId: v.workspaceId };
    }
    return { kind: 'system' };
}

function grantFor(appId: string): AppGrant | null {
    const row = getAppGrant(appId);
    if (!row) return null;
    return {
        appId: row.appId,
        appName: row.name,
        workspaceId: row.workspaceId,
        scope: row.scope,
        capabilities: row.capabilities,
        revoked: row.revoked,
        ...(row.workspaces ? { workspaces: row.workspaces } : {}),
    };
}

/**
 * What arming this flow will let it DO, in the capability model's own words.
 *
 * DERIVED from the graph, which is the whole reason a graph beats a recipe id
 * here: the sentence a person is asked to consent to cannot drift from the code,
 * because it IS the code. The recipe system carried a hand-written
 * `consequence` string per body, and a body whose steps changed kept the old
 * sentence until somebody noticed.
 *
 * Capability LABELS rather than tool names: "Run commands" is what a consent
 * prompt says elsewhere in Genie, and two surfaces describing the same authority
 * differently is how people learn to skim both.
 */
function consequenceOf(flow: FlowRow): string[] {
    const nodes = flow.graph && Array.isArray(flow.graph.nodes) ? flow.graph.nodes : [];
    const labels = new Set<string>();
    for (const raw of nodes) {
        const kind = typeof raw?.data?.kind === 'string' ? raw.data.kind : null;
        const node = kind ? genieNodeKind(kind) : null;
        if (node) labels.add(node.label);
    }
    return [...labels].sort();
}

/** How to name a flow's scope to a person. */
function scopeLabel(flow: FlowRow): string {
    if (!flow.scope) return 'Genie could not read where this belongs';
    if (flow.scope.kind === 'system') return 'This machine';
    if (flow.scope.kind === 'workspace') return `Workspace ${flow.scope.workspaceId}`;
    return getAppGrant(flow.scope.appId)?.name ?? 'An app that is no longer installed';
}

/** What a list row needs, without loading a canvas to draw it. */
function summarise(flow: FlowRow) {
    const last = lastFlowRuns().get(flow.id);
    return {
        /** What arming it lets it do — derived from the graph, never stored prose. */
        consequence: consequenceOf(flow),
        scopeLabel: scopeLabel(flow),
        id: flow.id,
        title: flow.title,
        purpose: flow.purpose,
        ...(flow.description ? { description: flow.description } : {}),
        scope: flow.scope,
        appId: flow.appId,
        enabled: flow.enabled,
        updatedAt: flow.updatedAt,
        /**
         * So the list can say "runs daily at 03:00" without loading the graph.
         *
         * An event trigger is annotated with whether anything still EMITS that
         * event. It is the one thing a list would never otherwise tell you: a
         * flow whose producer went away looks completely normal — enabled,
         * titled, pointing at an event — and simply never fires. A flow goes
         * dead LATER, so this cannot be checked once at authoring time.
         */
        triggers: flow.graph
            ? declaredTriggers(flow.graph).map((t) =>
                  t.kind === 'event'
                      ? { ...t, known: !!t.event && flowEventRegistry().get(t.event) !== undefined }
                      : t,
              )
            : [],
        /** A corrupt row is SAID so, not hidden — the user can open and repair it. */
        readable: flow.graph !== null && flow.scope !== null,
        ...(last ? { lastRun: last } : {}),
    };
}

export function registerFlowsIpc(deps: ServerDeps): void {
    ipcMain.handle('flows:list', (_e, vantage: unknown) =>
        listFlowsVisibleTo(readVantage(vantage)).map(summarise),
    );

    ipcMain.handle('flows:get', (_e, flowId: string) => getFlow(String(flowId)));

    ipcMain.handle('flows:runs', (_e, flowId: string, limit?: number) =>
        listFlowRuns(String(flowId), typeof limit === 'number' ? limit : undefined),
    );

    /**
     * Mint a new flow at a scope. Born disarmed, with a starter graph.
     *
     * Main's job rather than the renderer's: it owns the ids, the table, and
     * what a new flow starts as — and the renderer could not build the graph
     * anyway, because that needs the node registry and a `main/` module the
     * renderer imports has to be a leaf.
     */
    ipcMain.handle('flows:create', (_e, raw: unknown) => {
        const input = (raw ?? {}) as { scope?: unknown; title?: unknown; purpose?: unknown };
        const scope = parseFlowScope(input.scope);
        if (!scope) return null;

        const id = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        upsertFlow({
            id,
            scope,
            title:
                typeof input.title === 'string' && input.title.trim() !== ''
                    ? input.title.trim()
                    : 'New flow',
            ...(typeof input.purpose === 'string' ? { purpose: input.purpose } : {}),
            graph: starterFlowGraph(),
        });
        pushFlowsChanged();
        return getFlow(id);
    });

    /**
     * Save an edit. Never arms, and never disarms silently.
     *
     * `enabled` is deliberately absent from the payload — see the header. An
     * edit that changed what a flow does while leaving it armed would leave
     * consent that no longer describes the flow, so changing the GRAPH or the
     * SCOPE disarms it and says so.
     */
    ipcMain.handle('flows:save', (_e, raw: unknown) => {
        const input = (raw ?? {}) as {
            id?: unknown;
            title?: unknown;
            purpose?: unknown;
            description?: unknown;
            scope?: unknown;
            graph?: unknown;
        };
        const id = typeof input.id === 'string' ? input.id : '';
        if (!id) return null;

        const existing = getFlow(id);
        const scope = parseFlowScope(input.scope) ?? existing?.scope ?? null;
        if (!scope) return null;

        upsertFlow({
            id,
            scope,
            title:
                typeof input.title === 'string' && input.title.trim() !== ''
                    ? input.title.trim()
                    : (existing?.title ?? 'Flow'),
            ...(typeof input.purpose === 'string' ? { purpose: input.purpose } : {}),
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            graph: input.graph,
            enabled: existing ? existing.enabled && !changesConsent(existing, scope, input.graph) : false,
        });

        reconcileFlowSchedules();
        reconcileFlowWatches();
        pushFlowsChanged();
        return getFlow(id);
    });

    ipcMain.handle('flows:set-enabled', (_e, flowId: string, enabled: boolean) => {
        setFlowEnabled(String(flowId), enabled === true);
        reconcileFlowSchedules();
        reconcileFlowWatches();
        pushFlowsChanged();
        return getFlow(String(flowId));
    });

    ipcMain.handle('flows:delete', (_e, flowId: string) => {
        deleteFlow(String(flowId));
        reconcileFlowSchedules();
        reconcileFlowWatches();
        pushFlowsChanged();
        return true;
    });

    /**
     * What this graph WOULD be allowed to do — without running it.
     *
     * The editor calls this as the author works, so a refusal shows up on the
     * canvas rather than at 3am on the first scheduled fire.
     */
    ipcMain.handle('flows:check', (_e, rawScope: unknown, graph: unknown) => {
        const scope = parseFlowScope(rawScope);
        return decideFlowAdmission(graph as never, authorityForScope(scope, grantFor));
    });

    /**
     * The palette a given scope may author with.
     *
     * A `gapp` scope is filtered to what the app HOLDS, so the canvas cannot
     * offer a step certain to be refused. A user scope gets everything
     * classified — which is what a user could do anyway, and what arming the
     * flow consents to.
     */
    ipcMain.handle('flows:palette', (_e, rawScope: unknown) => {
        const scope = parseFlowScope(rawScope);
        const defs = genieNodeDefinitions();
        if (scope?.kind === 'gapp') {
            const grant = grantFor(scope.appId);
            const held = new Set(
                grant && !grant.revoked
                    ? paletteForCapabilities(grant.capabilities).map((k) => k.kind)
                    : [],
            );
            return { available: defs.filter((d) => held.has(d.name)), all: listGenieNodeKinds() };
        }
        return { available: defs, all: listGenieNodeKinds() };
    });

    ipcMain.handle('flows:run', async (_e, flowId: string) =>
        runFlowManually(String(flowId), deps),
    );

    // Bound so the runner's dependencies exist wherever a flow is started from.
    void flowRunnerDeps;
}

/**
 * Did this edit change what the user agreed to?
 *
 * The arming confirmation states two things — what the flow DOES and WHERE it
 * may act — so a change to either leaves consent that no longer describes the
 * flow, and it is disarmed. A rename or a new note changes neither and does not.
 *
 * Compared on the node kinds and the edges rather than the whole document:
 * moving a node on the canvas is not a change to what it does, and disarming
 * somebody's flow because they tidied the layout would train them to ignore the
 * warning.
 */
function changesConsent(existing: FlowRow, scope: FlowScope, nextGraph: unknown): boolean {
    if (JSON.stringify(existing.scope) !== JSON.stringify(scope)) return true;
    return consentDigest(existing.graph) !== consentDigest(nextGraph);
}

function consentDigest(graph: unknown): string {
    const g = (graph ?? {}) as { nodes?: unknown; edges?: unknown };
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const edges = Array.isArray(g.edges) ? g.edges : [];
    return JSON.stringify({
        kinds: nodes
            .map((n) => {
                const node = (n ?? {}) as { data?: { kind?: unknown; config?: unknown } };
                return {
                    kind: node.data?.kind ?? null,
                    // Config counts: a step whose workspace changed acts somewhere
                    // else, which is exactly half of what was agreed to.
                    config: node.data?.config ?? null,
                };
            })
            .sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
        edges: edges
            .map((e) => {
                const edge = (e ?? {}) as { source?: unknown; target?: unknown };
                return `${String(edge.source)}->${String(edge.target)}`;
            })
            .sort(),
    });
}
