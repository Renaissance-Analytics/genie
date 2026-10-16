import { describe, expect, it } from 'vitest';
import { serviceEnvFor, type ServiceInstance } from '../src/core/services.js';

/**
 * A WORKSPACE'S OWN CUSTOM ENGINE KEEPS ITS DATABASE (moic, via the owner, 2026-10-16: a regression in beta.28). A
 * custom engine that declares no `kind` gives the workspace the env the person wrote into it — DB_HOST, DB_PORT, … —
 * as Genie 1 did. Since #309 the shared Postgres beside it is "the postgres" for that workspace (a kind-less custom
 * image is no kind), and its DB_* were written OVER the custom engine's: the site would have silently moved to
 * Genie's own database on its next restart.
 *
 * The rule: what was set by hand on the workspace's own engine wins over what Genie derives from a shared one.
 * Every value is invented; names are RFC 2606 (`example-*`).
 */

const WS = 'example-moic';
const sharedPostgres = {
    id: 'svc_shared_pg', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: 4103, credentials: {}, active: true,
    admin: { user: 'genie', password: 'admin-pw' },
    slices: { [WS]: { identifier: 'ws_example_moic', password: 'slice-pw', active: true } },
} as unknown as ServiceInstance;
const ownCustom = {
    id: 'svc_own', engine: 'custom', version: 'own-pg', scope: { kind: 'dedicated', workspaceId: WS }, publishedPort: 4120, credentials: {}, active: true,
    image: 'pgvector/pgvector:pg17', internalPort: 5432,
    env: { DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: '4120', DB_DATABASE: 'moic_own', DB_USERNAME: 'moic', DB_PASSWORD: 'own-pw' },
} as unknown as ServiceInstance;

describe('a kind-less custom engine beside a shared Postgres', () => {
    it("the workspace keeps the DB_* the person set on its own engine — not the shared engine's", () => {
        const env = serviceEnvFor([sharedPostgres, ownCustom], WS);
        expect({ port: env.DB_PORT, db: env.DB_DATABASE, user: env.DB_USERNAME, pw: env.DB_PASSWORD }).toEqual({ port: '4120', db: 'moic_own', user: 'moic', pw: 'own-pw' });
    });

    it('CONTROL: without the custom engine the shared slice is what the workspace gets (the gauge sees a shared engine)', () => {
        const env = serviceEnvFor([sharedPostgres], WS);
        expect({ port: env.DB_PORT, db: env.DB_DATABASE }).toEqual({ port: '4103', db: 'ws_example_moic' });
    });

    it("another workspace's custom engine changes nothing here", () => {
        const theirs = { ...ownCustom, id: 'svc_theirs', scope: { kind: 'dedicated', workspaceId: 'example-other' } } as unknown as ServiceInstance;
        const env = serviceEnvFor([sharedPostgres, theirs], WS);
        expect(env.DB_PORT).toBe('4103');
    });
});
