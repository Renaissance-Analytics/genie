import { describe, expect, it } from 'vitest';
import { e2eViewQuery, E2E_WORKSPACE_ID } from '../view-query';
import { parseViewRoute } from '../../../renderer/lib/view-route';

/**
 * The harness's view override, which was built inline and untested until a spec needed to ask
 * for the WORKBENCH.
 *
 * The assertions below run the produced query back through `parseViewRoute` rather than
 * matching a string. A string match would have happily passed for `?view=workbench`, which the
 * route cannot satisfy — it degrades to the default surface, the window opens, renders
 * something real, and every panel assertion in the spec fails as "element not found". That
 * reads as the panel being broken rather than as the harness asking for the wrong screen, and
 * it costs three platforms about twelve minutes a shard to find out.
 */

/** `parseViewRoute` takes the parsed params, so split the query the way the browser would. */
const routeOf = (query: string) => {
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    return parseViewRoute(Object.fromEntries(params.entries()));
};

describe('no override', () => {
    it('produces NO query, so the harness opens what the product opens', () => {
        // Deliberate: a default surface that fails to render must be caught by a spec rather
        // than hidden behind an override that pins every window to a known-good screen.
        expect(e2eViewQuery(undefined)).toBe('');
        expect(e2eViewQuery('')).toBe('');
        expect(e2eViewQuery('   ')).toBe('');
    });
});

describe('named views', () => {
    it('no longer resolves the GRID, which has been removed', () => {
        // `?view=grid` still forms — the builder does not know which views exist — but the
        // route cannot satisfy it and degrades. Asserted rather than deleted, because a spec
        // that still passes `GENIE_E2E_VIEW=grid` would silently run against the DEFAULT
        // surface, and "element not found" reads as a broken panel rather than a stale env.
        expect(e2eViewQuery('grid')).toBe('?view=grid');
        expect(routeOf(e2eViewQuery('grid'))).toEqual({ kind: 'dashboard' });
    });

    it('asks for the deck by name', () => {
        expect(routeOf(e2eViewQuery('deck'))).toEqual({ kind: 'deck' });
    });

    it('asks for the dashboard by name', () => {
        expect(routeOf(e2eViewQuery('dashboard'))).toEqual({ kind: 'dashboard' });
    });
});

describe('the WORKBENCH, which has no view name', () => {
    it('resolves to the Workbench for the seeded workspace', () => {
        expect(routeOf(e2eViewQuery('workbench'))).toEqual({
            kind: 'workbench',
            workspaceId: E2E_WORKSPACE_ID,
        });
    });

    it('does NOT emit ?view=workbench, which the route cannot satisfy', () => {
        // The specific defect. Paired with the positive assertion above, because "does not
        // contain view=" would also pass for an empty string — which is itself a failure.
        const q = e2eViewQuery('workbench');
        expect(q).not.toContain('view=');
        expect(q).toContain('ws=');
    });

    it('takes an explicit workspace, encoded', () => {
        expect(routeOf(e2eViewQuery('workbench', 'a b/c'))).toEqual({
            kind: 'workbench',
            workspaceId: 'a b/c',
        });
    });
});

describe('POSITIVE CONTROL: an unknown name still degrades, and that is visible here', () => {
    it('emits it as a view, and the route falls back to the default', () => {
        // Not a silent success: this documents what a typo in GENIE_E2E_VIEW actually does, so
        // the next person who sees "the harness opened the wrong screen" finds the reason
        // here rather than deducing it from a red shard.
        expect(e2eViewQuery('nonsense')).toBe('?view=nonsense');
        expect(routeOf(e2eViewQuery('nonsense'))).toEqual({ kind: 'dashboard' });
    });
});
