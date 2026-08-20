import { describe, expect, it } from 'vitest';
import { callerIdForApp, resolveCaller, type CallerLookups } from '../caller-identity';

/**
 * WHO is making a tool call (Tynn #250).
 *
 * Every Genie tool resolves its workspace from the caller, and until now a caller
 * was always a terminal. A GApp has no terminal — it is a window — but the owner's
 * requirement is that a GApp can use Genie's FULL tool set under a consented
 * scope. Building a second dispatch path for apps would mean two implementations
 * of "may this caller act here?", and the laxer one would eventually win.
 *
 * So instead there is one caller identity with two kinds, resolved in one place.
 * The security consequence is that an app's authority is read from the GRANT — the
 * record of what the user consented to — and never from anything the caller says
 * about itself.
 */

const lookups = (over: Partial<CallerLookups> = {}): CallerLookups => ({
    terminalWorkspaceId: (id) => (id === 'term-1' ? 'ws-project' : null),
    appGrant: (appId) =>
        appId === 'com.example.trader'
            ? {
                  appId,
                  appName: 'Example Trader',
                  workspaceId: 'ws-app',
                  scope: 'self',
                  capabilities: ['hosting'],
                  revoked: false,
              }
            : null,
    ...over,
});

describe('a terminal caller', () => {
    it('resolves to the workspace its terminal is attached to', () => {
        const caller = resolveCaller('term-1', lookups());

        expect(caller.kind).toBe('terminal');
        expect(caller.workspaceId).toBe('ws-project');
    });

    it('has no authority when it is attached to nothing', () => {
        const caller = resolveCaller('term-unknown', lookups());
        expect(caller.workspaceId).toBeNull();
    });

    it('has no authority when there is no caller at all', () => {
        expect(resolveCaller('', lookups()).workspaceId).toBeNull();
    });
});

describe('a GApp caller', () => {
    const id = callerIdForApp('com.example.trader');

    it('is distinguishable from a terminal, so app rules can apply', () => {
        const caller = resolveCaller(id, lookups());

        expect(caller.kind).toBe('app');
        expect(caller.workspaceId).toBe('ws-app');
    });

    it('carries the GRANT, not what the caller claims about itself', () => {
        const caller = resolveCaller(id, lookups());
        expect(caller.kind === 'app' && caller.grant.capabilities).toEqual(['hosting']);
    });

    it('has no authority once revoked', () => {
        // Defence in depth. The bridge already refuses a revoked app; this makes a
        // revoked app unable to resolve a workspace even if a call reached the
        // dispatch layer another way.
        const caller = resolveCaller(
            id,
            lookups({
                appGrant: () => ({
                    appId: 'com.example.trader',
                    appName: 'Example Trader',
                    workspaceId: 'ws-app',
                    scope: 'self',
                    capabilities: ['hosting'],
                    revoked: true,
                }),
            }),
        );
        expect(caller.workspaceId).toBeNull();
    });

    it('has no authority when the app is not installed', () => {
        expect(resolveCaller(callerIdForApp('com.ghost.app'), lookups()).workspaceId).toBeNull();
    });

    it('is never mistaken for a terminal that happens to share its name', () => {
        // A terminal id can be anything. The prefix is what separates the two
        // namespaces, and a terminal literally named `gapp:com.example.trader`
        // must not inherit the app's grant.
        const caller = resolveCaller(
            id,
            lookups({ terminalWorkspaceId: () => 'ws-someone-elses' }),
        );
        expect(caller.workspaceId).toBe('ws-app');
    });

    it('does not resolve an app caller through the terminal table', () => {
        // The mirror: an uninstalled app id must fail closed rather than fall back
        // to a terminal lookup that might match.
        const caller = resolveCaller(
            callerIdForApp('com.ghost.app'),
            lookups({ terminalWorkspaceId: () => 'ws-anything' }),
        );
        expect(caller.workspaceId).toBeNull();
    });
});
