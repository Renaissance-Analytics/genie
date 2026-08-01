import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    addWorkspace,
    deleteWorkspaceHostedSite,
    getWorkspace,
    getWorkspaceHostedSites,
    initDatabase,
    removeWorkspace,
    runMigrations,
    setWorkspaceHostedSite,
} from '../../db';
import { hostedSiteIdFor } from '../sites-config';

/**
 * The `workspaces.hosted_sites` store (migration v29) against a REAL
 * better-sqlite3 — the binary is not mocked here (see vitest.config.ts), so the
 * ALTER, the JSON round-trip and the key derivation are all exercised for real.
 *
 * The property worth defending is that the stored KEY and the stored HOSTNAME
 * can never disagree. The key is the opaque siteId the Testing Browser resolves
 * a target by; if a rename left it pointing at the old hostname, the runtime
 * would serve one vhost while the browser dialed the id of another, and the
 * failure would look like "the site is up but the browser gets nothing".
 */

const WS = 'test.hosting.ws';

beforeAll(() => {
    // The singleton may already be open from another suite in this fork —
    // `initDatabase` returns the existing handle in that case, which is fine:
    // this suite only touches rows it creates.
    initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-hosting-db-')));
    if (!getWorkspace(WS)) {
        addWorkspace({
            id: WS,
            backend: 'aionima',
            project_id: WS,
            project_name: 'hosting fixture',
            tynn_project_id: WS,
            tynn_project_name: 'hosting fixture',
            shape: 'simple',
            path: path.join(os.tmpdir(), 'genie-hosting-fixture'),
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

describe('migration v29', () => {
    it('adds hosted_sites to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const columns = db
            .prepare<[], { name: string }>('PRAGMA table_info(workspaces)')
            .all()
            .map((r) => r.name);
        expect(columns).toContain('hosted_sites');
    });

    it('reads an untouched (pre-v29) workspace as "nothing hosted"', () => {
        // Every existing workspace gains the column as NULL. That has to mean
        // the safe default, not a crash and not an accidental enable.
        expect(getWorkspaceHostedSites(WS)).toEqual({});
    });
});

describe('setWorkspaceHostedSite', () => {
    it('stores a site under the id DERIVED from its hostname', () => {
        const siteId = setWorkspaceHostedSite(WS, {
            enabled: true,
            hostname: 'Round.Trip.Test',
            kind: 'php',
            docroot: 'public',
        });
        expect(siteId).toBe(hostedSiteIdFor('round.trip.test'));
        expect(getWorkspaceHostedSites(WS)[siteId!]).toEqual({
            enabled: true,
            hostname: 'round.trip.test',
            kind: 'php',
            docroot: 'public',
        });
    });

    it('merges a partial patch into the stored config', () => {
        const siteId = setWorkspaceHostedSite(WS, { siteId: hostedSiteIdFor('round.trip.test'), enabled: false });
        expect(getWorkspaceHostedSites(WS)[siteId!]).toEqual({
            enabled: false,
            hostname: 'round.trip.test',
            kind: 'php',
            docroot: 'public',
        });
    });

    it('MOVES the entry when the hostname is renamed, leaving no stale key', () => {
        const before = hostedSiteIdFor('round.trip.test');
        const after = setWorkspaceHostedSite(WS, { siteId: before, hostname: 'renamed.test' });
        expect(after).toBe(hostedSiteIdFor('renamed.test'));
        const stored = getWorkspaceHostedSites(WS);
        expect(stored[before]).toBeUndefined();
        expect(stored[after!]).toMatchObject({ hostname: 'renamed.test', kind: 'php' });
    });

    it('refuses a patch with no usable hostname', () => {
        expect(setWorkspaceHostedSite(WS, { kind: 'static' })).toBeNull();
        expect(setWorkspaceHostedSite(WS, { hostname: 'not a hostname' })).toBeNull();
    });

    it('never persists a docroot that escapes the workspace', () => {
        const siteId = setWorkspaceHostedSite(WS, {
            hostname: 'escape.test',
            kind: 'static',
            docroot: '../../../Windows',
        });
        expect(getWorkspaceHostedSites(WS)[siteId!]?.docroot).toBeUndefined();
    });
});

describe('deleteWorkspaceHostedSite', () => {
    it('forgets one site and leaves the others', () => {
        const keep = setWorkspaceHostedSite(WS, { hostname: 'keep.test', kind: 'static' })!;
        const drop = setWorkspaceHostedSite(WS, { hostname: 'drop.test', kind: 'static' })!;
        deleteWorkspaceHostedSite(WS, drop);
        const stored = getWorkspaceHostedSites(WS);
        expect(stored[drop]).toBeUndefined();
        expect(stored[keep]).toBeDefined();
    });

    it('deleting an unknown site is a no-op', () => {
        const before = getWorkspaceHostedSites(WS);
        deleteWorkspaceHostedSite(WS, 'never-stored');
        expect(getWorkspaceHostedSites(WS)).toEqual(before);
    });
});
