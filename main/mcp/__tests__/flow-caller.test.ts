import { describe, expect, it } from 'vitest';
import {
    appIdFromCallerId,
    callerIdForApp,
    flowCallerId,
    flowIdFromCallerId,
    resolveCaller,
    type CallerLookups,
} from '../caller-identity';

/**
 * A FLOW is a third kind of caller.
 *
 * `caller-identity.ts` exists because a GApp has no terminal and building a
 * second dispatch path for it would mean two implementations of "may this caller
 * act here?", with the laxer one eventually winning. A flow has no terminal
 * either — and it has something neither of the others does: it runs with nobody
 * watching.
 *
 * So it joins the same union rather than getting its own path, and its authority
 * comes from the flow's SCOPE, which is the record of what the user armed:
 *
 *   - a `workspace` flow acts in that workspace and nowhere else;
 *   - a `system` flow acts machine-wide — which is what the user turned on when
 *     they armed a machine-wide flow, and what the graph in front of them said
 *     it would do;
 *   - a `gapp` flow never gets here at all. It calls through `dispatchAppCall`
 *     as its app, so it resolves as `kind: 'app'` and inherits exactly the grant
 *     the app already holds.
 *
 * ## The prefixes cannot collide
 *
 * A terminal literally named `flow:nightly` must not inherit a flow's authority,
 * the same reason `gapp:` exists. Both prefixes are reserved and neither can be
 * produced by the other's id space.
 */

const lookups = (over: Partial<CallerLookups> = {}): CallerLookups => ({
    terminalWorkspaceId: () => null,
    appGrant: () => null,
    flowWorkspaceId: () => null,
    ...over,
});

describe('a flow caller id', () => {
    it('round-trips', () => {
        expect(flowIdFromCallerId(flowCallerId('nightly'))).toBe('nightly');
    });

    it('is not an app id, and an app id is not a flow id', () => {
        expect(flowIdFromCallerId(callerIdForApp('com.example.app'))).toBeNull();
        expect(appIdFromCallerId(flowCallerId('nightly'))).toBeNull();
    });

    it('is not produced by an ordinary terminal id', () => {
        expect(flowIdFromCallerId('term-123')).toBeNull();
    });
});

describe('resolving a flow caller', () => {
    it('acts in the workspace its scope names', () => {
        const caller = resolveCaller(
            flowCallerId('nightly'),
            lookups({ flowWorkspaceId: () => 'ws-7' }),
        );

        expect(caller).toEqual({ kind: 'flow', flowId: 'nightly', workspaceId: 'ws-7' });
    });

    it('acts machine-wide when its scope names no workspace', () => {
        // A system flow. `null` is not "nowhere" here — it is "not confined",
        // and `resolveAgentTarget` reads it that way.
        const caller = resolveCaller(flowCallerId('sweep'), lookups());

        expect(caller).toEqual({ kind: 'flow', flowId: 'sweep', workspaceId: null });
    });

    it('fails closed for a flow that is not there', () => {
        // A deleted flow whose run somehow outlived it. Not a terminal lookup
        // that might happen to match — the same rule an uninstalled app gets.
        const caller = resolveCaller(
            flowCallerId('deleted'),
            lookups({ flowWorkspaceId: () => undefined }),
        );

        expect(caller).toEqual({ kind: 'none', workspaceId: null });
    });

    it('never falls through to a terminal of the same name', () => {
        const caller = resolveCaller(
            flowCallerId('nightly'),
            lookups({
                flowWorkspaceId: () => undefined,
                // A terminal really called `flow:nightly` must not lend it authority.
                terminalWorkspaceId: () => 'ws-SNEAKY',
            }),
        );

        expect(caller.workspaceId).toBeNull();
    });
});

describe('the other two kinds still resolve', () => {
    it('leaves a terminal alone', () => {
        expect(
            resolveCaller('term-9', lookups({ terminalWorkspaceId: () => 'ws-1' })),
        ).toMatchObject({ kind: 'terminal', workspaceId: 'ws-1' });
    });

    it('leaves an empty caller as none', () => {
        expect(resolveCaller('', lookups())).toEqual({ kind: 'none', workspaceId: null });
    });
});
