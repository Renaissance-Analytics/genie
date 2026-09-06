/**
 * E2E fixture for the Flow Manager and its header button.
 *
 * Seeds real Flow rows so the manager has something to render, and hands the
 * spec a way to push run activity on the SAME `flows:activity` channel the
 * runtime broadcasts on in production.
 *
 * ## Why activity is pushed rather than run for real
 *
 * The animation's honesty — that it moves for exactly the Flows whose bodies
 * were entered, and stops when they end however they end — is decided in main
 * and is pinned there, by `flows/__tests__/run-announcement.test.ts` (the
 * runtime announces a start only for a body it actually executes) and
 * `flows/__tests__/activity.test.ts` (a start is closed by its finish, failures
 * included). Neither of those can see a pixel.
 *
 * What no unit test can answer is whether that state reaches the header and
 * makes it move, and a real run cannot answer it either: every built-in body
 * completes in single-digit milliseconds, so a spec racing it would be timing a
 * flicker. Holding the run open would need a recipe that exists only for tests,
 * which is worse — production would carry a body whose purpose is to be slow.
 *
 * So the spec drives the real channel with a controllable duration. A drift
 * between the broadcast in `flows/index.ts` and the listener in `preload.ts` is
 * caught separately and structurally, by `main/__tests__/flow-ipc-channels.test.ts`.
 */
import Database from 'better-sqlite3';
import { getDb } from '../db';
import { broadcastLocal } from '../remote';
import { GENIE_EVENT_TRIGGER_KIND } from '../flows/event-trigger';
import { newFlowEdge, newFlowNode } from '../flows/graph';
import { nodeKindForTool } from '../flows/nodes';

/** A Flow with a manual trigger — the manager's Run button acts on this one. */
export const E2E_MANUAL_FLOW_ID = 'e2e-flow-manual';
/** A Flow whose trigger event NOTHING emits — the "cannot fire" warning. */
export const E2E_DEAD_FLOW_ID = 'e2e-flow-dead';
/**
 * The title the authoring spec types into the editor.
 *
 * Shared so the seed can clear it: the E2E profile is reused across runs, and a
 * spec that crashed between creating and deleting would otherwise leave a
 * second row with the same title behind — which makes the NEXT run's row
 * locator ambiguous and fails a spec that has nothing wrong with it.
 */
export const E2E_AUTHORED_FLOW_TITLE = 'Made in the manager';

export interface FlowsFixture {
    manualFlowId: string;
    deadFlowId: string;
    /** Push run state exactly as the runtime's start/finish callbacks do. */
    emit: (running: string[]) => void;
}

/**
 * A trigger node, built by hand rather than through `newFlowNode`.
 *
 * `newFlowNode` reads the live registry, and `@genie/event_trigger` is
 * registered by `startFlows` with the events that exist RIGHT NOW — so a
 * hand-written node is the only way to seed a trigger naming an event nothing
 * emits, which is the whole point of the dead flow below. A flow goes dead when
 * its producer disappears LATER; it is not something the editor can create, and
 * the seed must not pretend otherwise.
 */
function deadEventTrigger(event: string) {
    return {
        id: 'ghost',
        type: GENIE_EVENT_TRIGGER_KIND,
        position: { x: 80, y: 80 },
        data: { kind: GENIE_EVENT_TRIGGER_KIND, label: 'When', config: { event } },
    };
}

/**
 * A graph the CANVAS could have produced.
 *
 * Built through `newFlowNode`, the one function Genie uses to make a node
 * anywhere, so the fixture cannot drift into a shape no user can author — which
 * is exactly how the executor-resolution bug survived a green unit suite.
 */
function manualGraph() {
    const start = newFlowNode('@particle-academy/manual_trigger', { x: 80, y: 80 }, 'start')!;
    const step = newFlowNode(nodeKindForTool('checkIssues'), { x: 80, y: 220 }, 'step');
    return {
        nodes: step ? [start, step] : [start],
        edges: step ? [newFlowEdge('start', 'step')] : [],
    };
}

function seedFlow(
    d: Database.Database,
    row: {
        id: string;
        title: string;
        purpose: string;
        description: string;
        graph: unknown;
        enabled?: boolean;
    },
): void {
    const now = new Date().toISOString();
    // Written straight to the table rather than through `upsertFlow` for the
    // dead one: nothing in Genie can CREATE a flow whose trigger names an event
    // with no producer, and it must stay that way. The manager still has to
    // handle the row, because a producer can go away after the flow was made.
    d.prepare(
        `INSERT INTO flows (id, app_id, title, purpose, description, scope_json,
                            graph_json, enabled, created_at, updated_at)
         VALUES (@id, NULL, @title, @purpose, @description, @scope_json,
                 @graph_json, @enabled, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, purpose = excluded.purpose,
             description = excluded.description, graph_json = excluded.graph_json,
             enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).run({
        id: row.id,
        title: row.title,
        purpose: row.purpose,
        description: row.description,
        scope_json: JSON.stringify({ kind: 'system' }),
        graph_json: JSON.stringify(row.graph),
        enabled: row.enabled === false ? 0 : 1,
        now,
    });
}

export function seedFlowsE2E(): FlowsFixture {
    const d = getDb();
    // The E2E profile is reused across runs — replace rather than accumulate.
    d.prepare('DELETE FROM flow_runs WHERE flow_id IN (?, ?)').run(
        E2E_MANUAL_FLOW_ID,
        E2E_DEAD_FLOW_ID,
    );
    // Anything a previous authoring run left behind, for the reason above.
    d.prepare('DELETE FROM flows WHERE title = ?').run(E2E_AUTHORED_FLOW_TITLE);

    seedFlow(d, {
        id: E2E_MANUAL_FLOW_ID,
        title: 'Tidy the workspace',
        purpose: 'Files',
        description: 'Runs when you ask it to.',
        graph: manualGraph(),
    });
    seedFlow(d, {
        id: E2E_DEAD_FLOW_ID,
        title: 'Watch a thing that left',
        purpose: 'Files',
        description: 'Its trigger no longer has a producer.',
        graph: { nodes: [deadEventTrigger('ghost:vanished')], edges: [] },
    });

    const fixture: FlowsFixture = {
        manualFlowId: E2E_MANUAL_FLOW_ID,
        deadFlowId: E2E_DEAD_FLOW_ID,
        emit: (running: string[]) =>
            broadcastLocal('flows:activity', { running, busy: running.length > 0 }),
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_FLOWS__ = fixture;
    return fixture;
}
