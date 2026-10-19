import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * GENIE'S OWN GROUP, AS THE DESIGN MOCKUP HAS IT (the owner, 2026-10-19: "make sure the dashboard is actually following
 * the design mockups"). The mockup opens with `genie · default agent · not in a workspace · 1 agent` and counts genie in
 * the header (3 waiting · 8 working · 1 idle = every row drawn). The Dashboard used to leave genie out entirely, because a
 * chip counting it would have had no row to point at; with its own group, every count has its row.
 */

const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'a', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, links: null, contextUsed: null, contextSize: null, ...over,
} as AgentRow);

const genie = row({ id: 'g', name: 'genie', workspaceId: '__genie__', state: 'working', duration: '1m' });
const rows = [row({ id: 'a1', name: 'atlas', state: 'working', duration: '12m' }), row({ id: 'a2', name: 'wren', state: 'waiting', ask: 'Allow php artisan migrate?' })];
const render = (g: AgentRow | null) =>
    renderToStaticMarkup(<Dashboard rows={rows} genie={g} workspaces={[{ id: 'tynn', path: '/w/tynn.agi', name: 'tynn' }]} onOpenAgent={() => {}} onAddAgent={() => {}} />);

describe('genie’s group on the Dashboard', () => {
    it('comes first: genie · default agent · not in a workspace · 1 agent, then its row', () => {
        const html = render(genie);
        const header = html.indexOf('data-genie-group');
        expect(header).toBeGreaterThan(-1);
        expect(html).toMatch(/data-genie-group[\s\S]*?default agent · not in a workspace[\s\S]*?1 agent/);
        expect(html.indexOf('data-agent="g"')).toBeGreaterThan(header);
        expect(html.indexOf('data-agent="g"')).toBeLessThan(html.indexOf('data-agent="a1"'));
    });

    it('the header counts genie, so every count has its row (COUNTED: 2 working)', () => {
        expect(render(genie)).toMatch(/data-chip="working"[^>]*>[\s\S]*?2 working/);
        // CONTROL: without genie's row, it is not counted.
        expect(render(null)).toMatch(/data-chip="working"[^>]*>[\s\S]*?1 working/);
        expect(render(null)).not.toContain('data-genie-group');
    });
});

describe('the snapshot carries genie’s row', () => {
    it('osAgent: genie’s own row, beside the workspace agents it is not one of', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie2-os-row-'));
        try {
            const registry = new Registry(new Store(dir));
            await registry.load({ name: 'alphar', healthy: true });
            const snap = registry.snapshot();
            expect(snap.osAgent).toMatchObject({ name: 'genie' });
            expect(snap.agents.some((a) => a.name === 'genie')).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
