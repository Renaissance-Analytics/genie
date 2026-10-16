import { describe, expect, it } from 'vitest';
import { configSync, githubAppStatus, tynnGate, type SyncTarget } from '../src/core/integrations.js';

/**
 * TYNN, GITHUB, CONFIG SYNC (§6.9) — the pure half.
 *
 * - Tynn is the OPTIONAL identity layer: Genie is fully usable signed out, and Tynn-gated rows are
 *   ANNOTATED, never dropped — a row that vanishes when you sign out reads as a feature that broke.
 * - The GitHub App has two distinct steps, AUTHORIZE (who you are) and INSTALL (which repos), and a
 *   feature blocked by a missing step says which step — "GitHub permissions are blocking features"
 *   is the Deck's signal, and this is what it points at.
 * - Config sync writes to FOUR independent targets; each reports its own result, and one failing
 *   never blocks or hides the others.
 */

describe('Tynn-gated rows are annotated, never dropped', () => {
    const rows = [
        { id: 'issues', label: 'Issues', tynn: true },
        { id: 'terminals', label: 'Terminals', tynn: false },
        { id: 'wishes', label: 'Wishes', tynn: true },
    ];

    it('signed out: every Tynn row is still present, with the annotation and the route to sign in', () => {
        const out = tynnGate(rows, { signedIn: false });
        expect(out).toHaveLength(3);
        expect(out.find((r) => r.id === 'issues')).toEqual({ id: 'issues', label: 'Issues', tynn: true, enabled: false, note: 'Sign in to Tynn to use this', route: 'genie://settings/tynn' });
        expect(out.find((r) => r.id === 'terminals')).toEqual({ id: 'terminals', label: 'Terminals', tynn: false, enabled: true, note: null, route: null });
    });

    it('signed in: everything enabled, no annotations', () => {
        const out = tynnGate(rows, { signedIn: true });
        expect(out.every((r) => r.enabled && r.note === null)).toBe(true);
    });
});

describe('the GitHub App — authorize and install are two steps', () => {
    it('nothing done → both steps pending and every GitHub feature blocked by AUTHORIZE', () => {
        const s = githubAppStatus({ authorized: false, installedRepos: [], neededRepos: ['Renaissance-Analytics/genie2'] });
        expect(s.steps).toEqual([{ id: 'authorize', done: false }, { id: 'install', done: false }]);
        expect(s.blocking).toBe(true);
        expect(s.blockedBy).toBe('authorize');
        expect(s.missingRepos).toEqual(['Renaissance-Analytics/genie2']);
        expect(s.signal).toEqual({ label: 'GitHub permissions are blocking features', route: 'genie://settings/github' });
    });

    it('authorized but not installed on the repos Genie needs → blocked by INSTALL, naming the repos', () => {
        const s = githubAppStatus({ authorized: true, installedRepos: ['Renaissance-Analytics/genie'], neededRepos: ['Renaissance-Analytics/genie', 'Renaissance-Analytics/genie2'] });
        expect(s.steps).toEqual([{ id: 'authorize', done: true }, { id: 'install', done: false }]);
        expect(s.blockedBy).toBe('install');
        expect(s.missingRepos).toEqual(['Renaissance-Analytics/genie2']);
        expect(s.blocking).toBe(true);
    });

    it('both done for every needed repo → not blocking, NO signal (a signal appears only when it is true)', () => {
        const s = githubAppStatus({ authorized: true, installedRepos: ['a/b'], neededRepos: ['a/b'] });
        expect(s.blocking).toBe(false);
        expect(s.blockedBy).toBeNull();
        expect(s.signal).toBeNull();
    });

    it('with no repos needed yet, install is not demanded — authorization alone is complete', () => {
        const s = githubAppStatus({ authorized: true, installedRepos: [], neededRepos: [] });
        expect(s.blocking).toBe(false);
        expect(s.steps[1]).toEqual({ id: 'install', done: true });
    });
});

describe('config sync — four independent targets', () => {
    const targets: SyncTarget[] = [
        { id: 'claude', label: 'Claude Code', write: async () => {} },
        { id: 'codex', label: 'Codex', write: async () => { throw new Error('config.toml is read-only'); } },
        { id: 'cursor', label: 'Cursor', write: async () => {} },
        { id: 'zed', label: 'Zed', write: async () => {} },
    ];

    it('writes every target and reports each result on its own; one failure neither blocks nor hides the others', async () => {
        const r = await configSync(targets, { GENIE_MCP_URL: 'http://127.0.0.1:4242' });
        expect(r.map((x) => [x.id, x.ok])).toEqual([['claude', true], ['codex', false], ['cursor', true], ['zed', true]]);
        expect(r.find((x) => x.id === 'codex')!.error).toBe('config.toml is read-only');
    });

    it('every target receives the same payload', async () => {
        const seen: unknown[] = [];
        const t: SyncTarget[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, write: async (payload) => { seen.push(payload); } }));
        await configSync(t, { k: 'v' });
        expect(seen).toEqual([{ k: 'v' }, { k: 'v' }, { k: 'v' }, { k: 'v' }]);
    });

    it('fewer or more than four targets is refused — the contract is four independent targets, not "some"', async () => {
        await expect(configSync(targets.slice(0, 3), {})).rejects.toThrow(/four/);
    });
});
