import { describe, expect, it } from 'vitest';
import { configSync, tynnGate, type SyncTarget } from '../src/core/integrations.js';

/**
 * TYNN, GITHUB, CONFIG SYNC (§6.9) — the pure half.
 *
 * - Tynn is the OPTIONAL identity layer: Genie is fully usable signed out, and Tynn-gated rows are
 *   ANNOTATED, never dropped — a row that vanishes when you sign out reads as a feature that broke.
 * - GitHub is no longer two steps the person ticks (beta.33 item 25; the owner, 2026-10-20: "functional not some dumb
 *   list"): its real status, read from GitHub, is pinned in test/github-core.test.ts and test/github-account.test.ts.
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
