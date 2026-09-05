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

function seedFlow(
    d: Database.Database,
    row: {
        id: string;
        title: string;
        purpose: string;
        description: string;
        triggers: unknown;
    },
): void {
    const now = new Date().toISOString();
    // Written straight to the table rather than through `upsertFlow`, because
    // the store REFUSES both of these — correctly, and that is the point. The
    // dead one names an event nothing emits; the manual one gives
    // `genie.relocate-file` no file to act on. Each is a row the manager has to
    // handle and the editor must never be able to create: a Flow goes dead when
    // its producer disappears LATER, not when it is written.
    d.prepare(
        `INSERT INTO flows (id, title, purpose, description, scope_json, triggers_json,
                            recipe_json, enabled, created_at, updated_at)
         VALUES (@id, @title, @purpose, @description, @scope_json, @triggers_json,
                 @recipe_json, 1, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, purpose = excluded.purpose,
             description = excluded.description, triggers_json = excluded.triggers_json,
             enabled = 1, updated_at = excluded.updated_at`,
    ).run({
        id: row.id,
        title: row.title,
        purpose: row.purpose,
        description: row.description,
        scope_json: JSON.stringify({ kind: 'system' }),
        triggers_json: JSON.stringify(row.triggers),
        recipe_json: JSON.stringify({ kind: 'builtin', recipeId: 'genie.relocate-file' }),
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
        triggers: [{ kind: 'manual' }],
    });
    seedFlow(d, {
        id: E2E_DEAD_FLOW_ID,
        title: 'Watch a thing that left',
        purpose: 'Files',
        description: 'Its trigger no longer has a producer.',
        triggers: [{ kind: 'event', event: 'ghost:vanished' }],
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
