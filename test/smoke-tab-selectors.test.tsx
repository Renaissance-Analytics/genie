import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { control } from './helpers/control-markup.js';

/**
 * THE SMOKE READS THE AGENT TAB THE WAY THE TAB SAYS IT (main went red after #1432, 2026-11-02: "a real window" 32b/32c).
 * #1432 made the agent view's tabs react-fancy Tabs: the tab on screen says so with `aria-selected="true"`, and
 * `data-active` is gone. Two reads in scripts/smoke-cdp.mjs still asked `[data-tab="stream"]` for `data-active`, so a click
 * that DID open the agent's Stream tab with its chat docked (agentId and chat subject both the agent's, in the run's own
 * payload) read `stream: null` and failed. This holds the smoke's reads to the markup the view renders.
 */
const SMOKE = readFileSync(fileURLToPath(new URL('../scripts/smoke-cdp.mjs', import.meta.url)), 'utf8');
/** Every attribute the smoke reads off an agent tab: `[data-tab="…"]')?.getAttribute('<attr>')`. */
const tabReads = [...SMOKE.matchAll(/\[data-tab="[a-z]+"\]'\)\??\.getAttribute\('([a-z-]+)'\)/g)].map((m) => m[1]);

describe('the agent view says which tab is on screen with aria-selected, not data-active', () => {
    const session = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const html = renderToStaticMarkup(
        <AgentView agent={{ id: 'a1', name: 'wren', provider: 'claude', fidelity: 'declared', cwd: '/w' }} session={session} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null}
            onNavigate={() => {}} onSelect={() => {}} now={() => 0} />,
    );

    it('the Stream tab is aria-selected="true" and carries no data-active (what the smoke must read)', () => {
        const stream = control(html, 'data-tab="stream"')!;
        expect(stream.open).toContain('aria-selected="true"');
        expect(stream.open).not.toContain('data-active');
    });
});

describe('scripts/smoke-cdp.mjs reads the agent tab’s aria-selected', () => {
    it('reads agent tabs at all (CONTROL: 32b, 32c and the history check are such reads)', () => {
        expect(tabReads.length).toBeGreaterThanOrEqual(3);
    });

    it('every read of an agent tab asks aria-selected', () => {
        expect(tabReads.filter((a) => a !== 'aria-selected')).toEqual([]);
    });
});
