import { describe, expect, it } from 'vitest';
import { decideAppTarget } from '../scope';

/**
 * Which workspace a GApp may act on (Tynn #250).
 *
 * A GApp installs into its OWN workspace and can reach Genie's tool surface. How
 * far that reach extends is the single most consequential thing the user consents
 * to at install, so the decision is pure and tested directly rather than inferred
 * from whatever the bridge happens to do.
 *
 * It returns the same `TargetDecision` shape agents already use
 * (`mcp/target-workspace.ts`), so the runtime keeps ONE chokepoint for "may this
 * caller act here?" and a GApp cannot end up on a second, laxer path.
 *
 * Fail-closed is the rule at every edge: an unknown scope, an empty allow-list, a
 * GApp with no workspace of its own — all refuse.
 */

const APP_WS = 'ws-app';

describe('a GApp scoped to ITSELF', () => {
    const scope = { scope: 'self' as const };

    it('may act on its own workspace', () => {
        const d = decideAppTarget(APP_WS, undefined, scope);
        expect(d.allowed).toBe(true);
        expect(d.workspaceId).toBe(APP_WS);
        expect(d.via).toBe('self');
    });

    it('may name its own workspace explicitly and still be allowed', () => {
        expect(decideAppTarget(APP_WS, APP_WS, scope).allowed).toBe(true);
    });

    it('may NOT reach another workspace — the default containment', () => {
        const d = decideAppTarget(APP_WS, 'ws-other', scope);
        expect(d.allowed).toBe(false);
        expect(d.via).toBe('denied');
        // The refusal has to say WHY, or an installed GApp looks broken rather
        // than correctly contained.
        expect(d.reason).toMatch(/scope|not allowed/i);
    });
});

describe('a GApp scoped to NAMED workspaces', () => {
    const scope = { scope: 'workspaces' as const, workspaces: ['ws-a', 'ws-b'] };

    it('may act on one it was granted', () => {
        const d = decideAppTarget(APP_WS, 'ws-a', scope);
        expect(d.allowed).toBe(true);
        expect(d.via).toBe('granted');
    });

    it('may still act on its own workspace, which is always implied', () => {
        expect(decideAppTarget(APP_WS, APP_WS, scope).allowed).toBe(true);
    });

    it('may NOT act on one absent from the list', () => {
        expect(decideAppTarget(APP_WS, 'ws-z', scope).allowed).toBe(false);
    });

    it('refuses everything when the list is empty — absent is not "all"', () => {
        const empty = { scope: 'workspaces' as const, workspaces: [] };
        expect(decideAppTarget(APP_WS, 'ws-a', empty).allowed).toBe(false);
    });
});

describe('a GApp scoped to the WORKSTATION', () => {
    const scope = { scope: 'workstation' as const };

    it('may act on any workspace on this machine', () => {
        const d = decideAppTarget(APP_WS, 'anything', scope);
        expect(d.allowed).toBe(true);
        expect(d.via).toBe('workstation');
    });
});

describe('fail-closed edges', () => {
    it('refuses when the GApp has no workspace of its own', () => {
        // Nothing to be scoped RELATIVE to. A GApp with no workspace has no
        // authority to extend, so even `workstation` gets nothing.
        expect(decideAppTarget(null, 'ws-a', { scope: 'workstation' }).allowed).toBe(false);
        expect(decideAppTarget(null, undefined, { scope: 'self' }).allowed).toBe(false);
    });

    it('refuses an unrecognised scope instead of falling through to allow', () => {
        const d = decideAppTarget(APP_WS, 'ws-a', { scope: 'admin' } as never);
        expect(d.allowed).toBe(false);
        expect(d.via).toBe('denied');
    });

    it('treats a blank requested id as "my own workspace", not as a wildcard', () => {
        expect(decideAppTarget(APP_WS, '   ', { scope: 'self' }).workspaceId).toBe(APP_WS);
    });
});
