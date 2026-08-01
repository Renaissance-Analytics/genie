import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    addWorkspace,
    deleteWorkspaceService,
    getWorkspace,
    getWorkspaceServices,
    initDatabase,
    removeWorkspace,
    runMigrations,
    setWorkspaceService,
} from '../../../db';
import { serviceIdFor } from '../config';

/**
 * The `workspaces.workspace_services` store (migration v30) against a REAL
 * better-sqlite3 — the binary is not mocked here (see vitest.config.ts), so the
 * ALTER, the JSON round-trip and the credential minting are exercised for real.
 *
 * Two properties are worth the trouble of a real database.
 *
 * The credential is minted ONCE. It ends up in the user's `.env`, so rotating it
 * on a later write would silently break an app that is already using it — and
 * the only symptom would be a failed boot some time later.
 *
 * And a workspace can never accumulate two entries of one kind. The key is
 * derived from (workspace, kind) rather than supplied, so there is no way for a
 * second Postgres to appear pointing at a different data directory while the
 * first still holds the port.
 */

const WS = 'test.services.ws';

beforeAll(() => {
    // The singleton may already be open from another suite in this fork —
    // `initDatabase` returns the existing handle in that case, which is fine:
    // this suite only touches rows it creates.
    initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-services-db-')));
    if (!getWorkspace(WS)) {
        addWorkspace({
            id: WS,
            backend: 'aionima',
            project_id: WS,
            project_name: 'services fixture',
            tynn_project_id: WS,
            tynn_project_name: 'services fixture',
            shape: 'simple',
            path: path.join(os.tmpdir(), 'genie-services-fixture'),
            editor: null,
            editor_cmd: null,
            start_cmd: null,
            env_file: null,
            last_opened_at: null,
            created_by_genie: 0,
        });
    }
});

afterAll(() => {
    removeWorkspace(WS);
});

describe('migration v30', () => {
    it('adds workspace_services to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const columns = db
            .prepare<[], { name: string }>('PRAGMA table_info(workspaces)')
            .all()
            .map((r) => r.name);
        expect(columns).toContain('workspace_services');
    });

    it('is a SIBLING of hosted_sites, not a replacement', () => {
        // What Genie SERVES and what those sites CONNECT TO have different
        // lifecycles — disabling a site must not tear down its data.
        const db = new Database(':memory:');
        runMigrations(db);
        const columns = db
            .prepare<[], { name: string }>('PRAGMA table_info(workspaces)')
            .all()
            .map((r) => r.name);
        expect(columns).toContain('hosted_sites');
        expect(columns).toContain('workspace_services');
    });

    it('is idempotent', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
    });
});

describe('workspace services store', () => {
    it('reads as "nothing configured" before anything is written', () => {
        expect(getWorkspaceServices(WS)).toEqual({});
    });

    it('round-trips a service under its derived key', () => {
        const serviceId = setWorkspaceService(WS, 'postgres', { enabled: true });
        expect(serviceId).toBe(serviceIdFor(WS, 'postgres'));
        const stored = getWorkspaceServices(WS)[serviceId!]!;
        expect(stored.kind).toBe('postgres');
        expect(stored.enabled).toBe(true);
    });

    it('mints a password and a database on first write', () => {
        const serviceId = setWorkspaceService(WS, 'postgres', { enabled: true })!;
        const stored = getWorkspaceServices(WS)[serviceId]!;
        expect(stored.password).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(stored.database).toBe('genie');
    });

    it('NEVER rotates the password on a later write', () => {
        const serviceId = setWorkspaceService(WS, 'postgres', { enabled: true })!;
        const first = getWorkspaceServices(WS)[serviceId]!.password;
        setWorkspaceService(WS, 'postgres', { enabled: false });
        setWorkspaceService(WS, 'postgres', { enabled: true, database: 'shop' });
        const after = getWorkspaceServices(WS)[serviceId]!;
        expect(after.password).toBe(first);
        expect(after.database).toBe('shop');
    });

    it('refuses a caller-supplied password', () => {
        const serviceId = setWorkspaceService(WS, 'postgres', { enabled: true })!;
        const before = getWorkspaceServices(WS)[serviceId]!.password;
        setWorkspaceService(WS, 'postgres', {
            enabled: true,
            password: 'attacker-chosen',
        } as never);
        expect(getWorkspaceServices(WS)[serviceId]!.password).toBe(before);
    });

    it('keeps at most ONE entry per kind, however often it is written', () => {
        for (let i = 0; i < 5; i += 1) setWorkspaceService(WS, 'postgres', { enabled: i % 2 === 0 });
        setWorkspaceService(WS, 'redis', { enabled: true });
        const stored = getWorkspaceServices(WS);
        expect(Object.keys(stored)).toHaveLength(2);
        expect(Object.values(stored).filter((s) => s.kind === 'postgres')).toHaveLength(1);
    });

    it('gives redis no credentials', () => {
        const serviceId = setWorkspaceService(WS, 'redis', { enabled: true })!;
        const stored = getWorkspaceServices(WS)[serviceId]!;
        expect(stored.password).toBeUndefined();
        expect(stored.database).toBeUndefined();
    });

    it('removes one kind without touching the other', () => {
        setWorkspaceService(WS, 'postgres', { enabled: true });
        setWorkspaceService(WS, 'redis', { enabled: true });
        deleteWorkspaceService(WS, 'redis');
        const stored = getWorkspaceServices(WS);
        expect(Object.values(stored).map((s) => s.kind)).toEqual(['postgres']);
    });

    it('is a no-op when removing something that was never there', () => {
        deleteWorkspaceService(WS, 'redis');
        expect(() => deleteWorkspaceService(WS, 'redis')).not.toThrow();
    });

    it('separates workspaces', () => {
        // Not the same key, so one workspace's row can never be read as
        // another's.
        expect(serviceIdFor(WS, 'postgres')).not.toBe(serviceIdFor('other.ws', 'postgres'));
    });
});
