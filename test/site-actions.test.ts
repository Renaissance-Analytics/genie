import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SiteActions } from '../src/renderer/site-actions.js';
import type { FeatureAction } from '../src/renderer/features.js';

/**
 * A SITE BUTTON NEVER FIRES TWICE AND NEVER GOES SILENT (genie#1393). The owner: "I have no idea if anything is actually
 * happening when I clicked the button … other users might not realize anything is happening and spam the restart
 * button, I almost did."
 *
 * The click is pending from the moment it is made until main answers. A second click on the same site while it is
 * pending is IGNORED (main joins one too: site-manager `restart({ join })`). A refusal is kept on the row, with the
 * action that met it, so the row can show the reason and Retry. Never only in the console.
 */
function held() {
    const sent: FeatureAction[] = [];
    const answers: Array<(o: { ok: true } | { ok: false; reason: string }) => void> = [];
    const actions = new SiteActions((a) => { sent.push(a); return new Promise((r) => { answers.push(r); }); });
    let changes = 0;
    actions.subscribe(() => { changes++; });
    return { sent, answers, actions, changes: () => changes };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const restart = { kind: 'hosting.restartSite', siteId: 'site_web' } as const;

describe('SiteActions', () => {
    it('a click is pending AT ONCE (before main answers) and says which action', () => {
        const h = held();
        expect(h.actions.click(restart)).toBe(true);
        expect(h.actions.pending('site_web')).toBe('restart');
        expect(h.changes()).toBe(1);
    });

    it('a second click on the same site while pending is ignored: ONE action reaches main', () => {
        const h = held();
        h.actions.click(restart);
        expect(h.actions.click(restart)).toBe(false);
        expect(h.actions.click({ kind: 'hosting.stopSite', siteId: 'site_web' })).toBe(false);
        expect(h.sent).toEqual([restart]);
    });

    it('another site is not blocked by this one (positive control of the same shape)', () => {
        const h = held();
        h.actions.click(restart);
        expect(h.actions.click({ kind: 'hosting.restartSite', siteId: 'site_docs' })).toBe(true);
        expect(h.sent).toHaveLength(2);
    });

    it('main\'s answer ends the pending state; the next click goes through', async () => {
        const h = held();
        h.actions.click(restart);
        h.answers[0]!({ ok: true });
        await settle();
        expect(h.actions.pending('site_web')).toBeNull();
        expect(h.actions.click(restart)).toBe(true);
    });

    it('a refusal is KEPT on the site with its action (for the row\'s reason and Retry); the next click clears it', async () => {
        const h = held();
        h.actions.click(restart);
        h.answers[0]!({ ok: false, reason: 'web.gen cannot be served by Genie 2: no Caddy' });
        await settle();
        expect(h.actions.pending('site_web')).toBeNull();
        expect(h.actions.refusal('site_web')).toEqual({ action: restart, reason: 'web.gen cannot be served by Genie 2: no Caddy' });
        h.actions.click(restart);
        expect(h.actions.refusal('site_web')).toBeNull();
    });

    it('a thrown action is a refusal too, in its own words (Electron\'s wrapper stripped)', async () => {
        const actions = new SiteActions(() => Promise.reject(new Error("Error invoking remote method 'genie:features-act': Error: no site site_web")));
        actions.click(restart);
        await settle();
        expect(actions.refusal('site_web')?.reason).toBe('no site site_web');
    });

    it('a non-site action passes straight through and is never held', () => {
        const h = held();
        expect(h.actions.click({ kind: 'hosting.editSite', siteId: 'site_web' })).toBe(true);
        expect(h.actions.pending('site_web')).toBeNull();
    });
});

describe('the surfaces use it', () => {
    it('SiteList routes site actions through useSiteActions and gives each row its pending/refusal; the Hosting tab and the workspace Sites modal both draw SiteList, never bare rows', () => {
        const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
        const surfaces = read('../src/renderer/components/FeatureSurfaces.tsx');
        const modal = read('../src/renderer/components/WorkspaceRuntimeModal.tsx');
        const list = /export function SiteList[\s\S]*?\n}\n/.exec(surfaces)?.[0] ?? '';
        expect(list).not.toBe('');
        expect(list).toMatch(/useSiteActions\(onAction\)/);
        expect(list).toMatch(/<SiteRow [^>]*pending=\{siteActions\.pending\(s\.id\)\}[^>]*refusal=\{siteActions\.refusal\(s\.id\)\}[^>]*onAction=\{\(a\) => \{ siteActions\.click\(a\); \}\}/);
        for (const src of [surfaces, modal]) {
            expect(src).toMatch(/<SiteList sites=\{/);
            // The only SiteRow outside SiteList's own body is none.
            expect(src.replace(list, '')).not.toMatch(/<SiteRow /);
        }
    });

    it('App\'s onFeature answers with the outcome, so a click can tell success from refusal', () => {
        const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
        expect(app).toMatch(/onFeature=\{\(action\) =>\s*\(resolvedBridge\?\.features \?\? NO_FEATURES\)\.act\(action\)\.then\(/);
        expect(app).toMatch(/return \{ ok: true as const \}/);
        expect(app).toMatch(/return \{ ok: false as const, reason/);
    });
});
