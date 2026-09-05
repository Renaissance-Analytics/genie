import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v71 — THE ENGINE IS SOCKUDO, SO STOP CALLING IT REVERB.
 *
 * Genie's bundled WebSocket server is Sockudo (`sockudo/sockudo 4.7.0`), and it
 * was keyed in the service catalog as `reverb` — the name of a DIFFERENT
 * product, Laravel's own server, which Genie does not ship. It read as a
 * statement about what was running and it was wrong, and it confused a real
 * user debugging a socket.
 *
 * The engine key is stored data: a workspace that added the service has
 * `{"<id>":{"engine":"reverb",…}}` in `workspaces.dev_services`. Renaming the
 * key in the catalog without moving those rows would leave every existing
 * workspace holding a service whose engine no longer exists — `engineSpecFor`
 * returns undefined and the service vanishes from the UI rather than being
 * renamed. So the blob is rewritten here.
 *
 * ## What this migration deliberately does NOT touch
 *
 * The `REVERB_*` environment variables. Those are not Genie's vocabulary — they
 * are Laravel's reverb-driver contract, which is what a hosted app reads, and
 * dropping them would break every app the moment it restarted. They keep being
 * emitted (see `env-wiring.ts`), now beside canonical `GENIE_WS_*` names.
 */

/** A database holding a workspace that added the service under the OLD key. */
function preV71(): Database.Database {
    const d = new Database(':memory:');
    runMigrations(d);
    d.prepare(
        `INSERT INTO workspaces
           (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
            shape, path, last_opened_at, created_by_genie, dev_services)
         VALUES (@id, 'tynn', @pid, @name, @pid, @name, 'simple', @path, 0, 0, @services)`,
    ).run({
        id: 'ws-a',
        pid: 'p-ws-a',
        name: 'Acme',
        path: '/tmp/ws-a',
        services: JSON.stringify({
            s1: { engine: 'reverb', version: '1', dedicated: false, password: 'kept' },
            s2: { engine: 'postgres', version: '17', dedicated: false, password: 'untouched' },
        }),
    });
    d.prepare('DELETE FROM schema_version WHERE version >= 71').run();
    return d;
}

describe('v71 — the websockets engine stops being called reverb', () => {
    it('renames the stored engine key so an existing service survives the rename', () => {
        const d = preV71();
        runMigrations(d);
        const row = d
            .prepare<[], { dev_services: string }>(
                `SELECT dev_services FROM workspaces WHERE id = 'ws-a'`,
            )
            .get();
        const services = JSON.parse(row!.dev_services);
        expect(services.s1.engine).toBe('websockets');
        // The workspace's own credential is what its running server derives every
        // app secret from — losing it would silently break the socket it fixes.
        expect(services.s1.password).toBe('kept');
        expect(services.s1.version).toBe('1');
        d.close();
    });

    it('leaves every other engine alone', () => {
        const d = preV71();
        runMigrations(d);
        const services = JSON.parse(
            d
                .prepare<[], { dev_services: string }>(
                    `SELECT dev_services FROM workspaces WHERE id = 'ws-a'`,
                )
                .get()!.dev_services,
        );
        expect(services.s2).toEqual({
            engine: 'postgres',
            version: '17',
            dedicated: false,
            password: 'untouched',
        });
        d.close();
    });

    it('is a no-op on a workspace with no services, and does not invent a column value', () => {
        const d = new Database(':memory:');
        runMigrations(d);
        d.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
                shape, path, last_opened_at, created_by_genie)
             VALUES ('ws-b', 'tynn', 'p-b', 'B', 'p-b', 'B', 'simple', '/tmp/b', 0, 0)`,
        ).run();
        d.prepare('DELETE FROM schema_version WHERE version >= 71').run();
        expect(() => runMigrations(d)).not.toThrow();
        const row = d
            .prepare<[], { dev_services: string | null }>(
                `SELECT dev_services FROM workspaces WHERE id = 'ws-b'`,
            )
            .get();
        expect(row!.dev_services).toBeNull();
        d.close();
    });
});
