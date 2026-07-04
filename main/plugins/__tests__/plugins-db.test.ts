import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    initDatabase,
    getDb,
    upsertPlugin,
    getPlugin,
    listPlugins,
    listEnabledPlugins,
    setPluginEnabled,
    setPluginGrants,
    deletePlugin,
    upsertPluginMarketplace,
    getPluginMarketplace,
    listPluginMarketplaces,
    deletePluginMarketplace,
    parsePluginGrants,
    emptyPluginGrants,
    type PluginGrants,
} from '../../db';

/**
 * The Plugin System DB layer (migration v19 + CRUD). Exercises the REAL
 * better-sqlite3 store (a temp userData dir), so the schema, the grants JSON
 * round-trip, and the enabled/marketplace relationships are covered end to end.
 */

let dir: string;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-plugins-db-'));
    initDatabase(dir);
});

afterAll(() => {
    // Clean up rows this suite created (the singleton may be shared).
    for (const p of listPlugins()) if (p.id.startsWith('test.')) deletePlugin(p.id);
    for (const m of listPluginMarketplaces()) if (m.id.startsWith('test.')) deletePluginMarketplace(m.id);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

function grants(): PluginGrants {
    return { fs: { workspace: true }, network: { 'api.example.com': true }, genieApi: { openFileForUser: true } };
}

describe('migration v19 — plugins + plugin_marketplaces tables', () => {
    it('creates both tables with their columns', () => {
        const cols = (t: string) =>
            new Set(
                getDb().prepare<[], { name: string }>(`PRAGMA table_info(${t})`).all().map((r) => r.name),
            );
        const p = cols('plugins');
        for (const c of ['id', 'namespace', 'enabled', 'manifest_json', 'granted_json', 'integrity', 'marketplace_id']) {
            expect(p.has(c)).toBe(true);
        }
        const m = cols('plugin_marketplaces');
        for (const c of ['id', 'name', 'url', 'official', 'manifest_json']) {
            expect(m.has(c)).toBe(true);
        }
    });
});

describe('plugin CRUD', () => {
    it('installs, reads back (enabled false + grants), and lists a plugin', () => {
        const rowManifest = JSON.stringify({ id: 'test.plugin.a', namespace: 'a', name: 'A', version: '1.0.0' });
        const created = upsertPlugin({
            id: 'test.plugin.a',
            namespace: 'a',
            name: 'Alpha',
            version: '1.0.0',
            source_type: 'repo',
            source_url: 'https://example.com/a.git',
            source_ref: 'deadbeef',
            install_path: '/tmp/plugins/test.plugin.a',
            manifest_json: rowManifest,
            grants: grants(),
        });
        expect(created.enabled).toBe(false); // fail-closed default
        expect(created.grants.fs.workspace).toBe(true);
        expect(created.source_ref).toBe('deadbeef');

        const read = getPlugin('test.plugin.a');
        expect(read?.name).toBe('Alpha');
        expect(read?.grants.network['api.example.com']).toBe(true);
        expect(listPlugins().some((p) => p.id === 'test.plugin.a')).toBe(true);
        expect(listEnabledPlugins().some((p) => p.id === 'test.plugin.a')).toBe(false);
    });

    it('enables + disables a plugin (moving it in/out of the enabled set)', () => {
        setPluginEnabled('test.plugin.a', true);
        expect(getPlugin('test.plugin.a')?.enabled).toBe(true);
        expect(listEnabledPlugins().some((p) => p.id === 'test.plugin.a')).toBe(true);
        setPluginEnabled('test.plugin.a', false);
        expect(listEnabledPlugins().some((p) => p.id === 'test.plugin.a')).toBe(false);
    });

    it('replaces the granular grants map', () => {
        const revoked = emptyPluginGrants();
        revoked.fs.workspace = false;
        setPluginGrants('test.plugin.a', revoked);
        expect(getPlugin('test.plugin.a')?.grants.fs.workspace).toBe(false);
    });

    it('re-install (upsert) keeps the enabled flag + prior row identity', () => {
        setPluginEnabled('test.plugin.a', true);
        upsertPlugin({
            id: 'test.plugin.a',
            namespace: 'a',
            name: 'Alpha v2',
            version: '2.0.0',
            source_type: 'repo',
            install_path: '/tmp/plugins/test.plugin.a',
            manifest_json: '{}',
            grants: emptyPluginGrants(),
            enabled: true,
        });
        const read = getPlugin('test.plugin.a');
        expect(read?.version).toBe('2.0.0');
        expect(read?.enabled).toBe(true);
        deletePlugin('test.plugin.a');
        expect(getPlugin('test.plugin.a')).toBeNull();
    });
});

describe('marketplace CRUD', () => {
    it('adds, reads, lists (official first), and removes a marketplace', () => {
        upsertPluginMarketplace({
            id: 'test.market.one',
            name: 'One',
            url: 'https://example.com/market.git',
            manifest_json: JSON.stringify({ id: 'test.market.one', name: 'One', plugins: [] }),
        });
        const read = getPluginMarketplace('test.market.one');
        expect(read?.name).toBe('One');
        expect(read?.official).toBe(false);
        expect(listPluginMarketplaces().some((m) => m.id === 'test.market.one')).toBe(true);
        deletePluginMarketplace('test.market.one');
        expect(getPluginMarketplace('test.market.one')).toBeNull();
    });
});

describe('parsePluginGrants (robustness)', () => {
    it('defaults corrupt/empty JSON to all-denied (fail-closed)', () => {
        expect(parsePluginGrants(null)).toEqual({ fs: {}, network: {}, genieApi: {} });
        expect(parsePluginGrants('{ not json')).toEqual({ fs: {}, network: {}, genieApi: {} });
    });

    it('coerces non-true values to false', () => {
        const g = parsePluginGrants(JSON.stringify({ fs: { workspace: 1 }, network: { host: true } }));
        expect(g.fs.workspace).toBe(false);
        expect(g.network.host).toBe(true);
    });
});
