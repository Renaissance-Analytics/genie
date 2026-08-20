import { describe, expect, it } from 'vitest';
import { decideAppCall, type AppGrant } from '../bridge-decision';

/**
 * The one gate every GApp call goes through (Tynn #250).
 *
 * A GApp is third-party code that wants terminals, hosting, the filesystem and the
 * agent surface. The window it runs in has no `window.genie`; the ONLY way out is
 * a mediated bridge, and this is the decision that bridge makes. It is the whole
 * security surface of the feature, so it is pure, and every refusal is asserted
 * rather than assumed.
 *
 * Two independent questions, both of which must pass:
 *
 *   1. WHAT — is this tool covered by a capability the user granted?
 *   2. WHERE — may this app act on the workspace it is asking about?
 *
 * They are separate because they fail for different reasons and the user needs to
 * be told which. "Not granted Run commands" is fixable in the app's settings;
 * "this app may only act on its own workspace" is a different conversation.
 */

const grant = (over: Partial<AppGrant> = {}): AppGrant => ({
    appId: 'com.example.trader',
    appName: 'Example Trader',
    workspaceId: 'ws-app',
    scope: 'self',
    capabilities: ['hosting'],
    revoked: false,
    ...over,
});

describe('a call the user consented to', () => {
    it('is allowed, and says which capability carried it', () => {
        const d = decideAppCall({ tool: 'manageSite' }, grant());

        expect(d.allowed).toBe(true);
        expect(d.capability).toBe('hosting');
        expect(d.workspaceId).toBe('ws-app');
    });

    it('reaches every tool the granted capability covers', () => {
        // `hosting` is sites AND services — a grant covers the capability, not one
        // tool of it, or the consent prompt would have been a lie.
        expect(decideAppCall({ tool: 'manageService' }, grant()).allowed).toBe(true);
    });
});

describe('WHAT — capability', () => {
    it('refuses a tool no granted capability covers, and names the missing one', () => {
        const d = decideAppCall({ tool: 'manageTerminals' }, grant());

        expect(d.allowed).toBe(false);
        // The user has to be able to act on this: which permission, on which app.
        expect(d.reason).toContain('Run commands');
        expect(d.reason).toContain('Example Trader');
    });

    it('refuses a tool that is off limits to every app, with the standing reason', () => {
        // Granting is not even possible here, so the message must not suggest the
        // user could go and enable it.
        const d = decideAppCall({ tool: 'submitFeedback' }, grant({ capabilities: ['hosting'] }));

        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/impersonat/i);
    });

    it('refuses a tool nothing classifies — an unknown name is not a free pass', () => {
        const d = decideAppCall({ tool: 'someFutureTool' }, grant({ capabilities: ['hosting'] }));
        expect(d.allowed).toBe(false);
    });

    it('ignores a granted capability that is not real', () => {
        // Defence in depth: the manifest already rejects these, but a hand-edited
        // or migrated grant row must not be able to smuggle one in.
        const d = decideAppCall({ tool: 'manageTerminals' }, grant({ capabilities: ['root'] }));
        expect(d.allowed).toBe(false);
    });
});

describe('WHERE — scope', () => {
    it("lets a self-scoped app act on its OWN workspace", () => {
        expect(decideAppCall({ tool: 'manageSite', workspaceId: 'ws-app' }, grant()).allowed).toBe(
            true,
        );
    });

    it('refuses a self-scoped app reaching another workspace', () => {
        const d = decideAppCall({ tool: 'manageSite', workspaceId: 'ws-other' }, grant());

        expect(d.allowed).toBe(false);
        expect(d.reason).toContain('ws-other');
    });

    it('lets a workstation-scoped app reach another workspace', () => {
        const d = decideAppCall(
            { tool: 'manageSite', workspaceId: 'ws-other' },
            grant({ scope: 'workstation' }),
        );

        expect(d.allowed).toBe(true);
        expect(d.workspaceId).toBe('ws-other');
        expect(d.via).toBe('workstation');
    });

    it('honours a named allow-list and nothing beyond it', () => {
        const g = grant({ scope: 'workspaces', workspaces: ['ws-allowed'] });

        expect(decideAppCall({ tool: 'manageSite', workspaceId: 'ws-allowed' }, g).allowed).toBe(
            true,
        );
        expect(decideAppCall({ tool: 'manageSite', workspaceId: 'ws-elsewhere' }, g).allowed).toBe(
            false,
        );
    });

    it('checks capability BEFORE scope, so the reason is the actionable one', () => {
        // Both are wrong here. Telling the user about the workspace would send them
        // to change a setting that was never the problem.
        const d = decideAppCall(
            { tool: 'manageTerminals', workspaceId: 'ws-other' },
            grant({ scope: 'self', capabilities: [] }),
        );
        expect(d.reason).toContain('Run commands');
    });
});

describe('fail closed', () => {
    it('refuses when there is no grant at all', () => {
        const d = decideAppCall({ tool: 'manageSite' }, null);
        expect(d.allowed).toBe(false);
    });

    it('refuses everything once the grant is revoked', () => {
        // Revocation must be immediate and total — including the capability the app
        // still has listed in its own manifest.
        const d = decideAppCall({ tool: 'manageSite' }, grant({ revoked: true }));

        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/revoked|turned off|disabled/i);
    });

    it('refuses an app with no workspace of its own', () => {
        const d = decideAppCall({ tool: 'manageSite' }, grant({ workspaceId: '' }));
        expect(d.allowed).toBe(false);
    });
});

describe('attribution', () => {
    it('flags a call that will put words in front of the user', () => {
        // The bridge must stamp the app's name on this. A GApp raising an
        // always-on-top modal that looked like a Genie system prompt is exactly the
        // impersonation the manifest's reserved names exist to prevent.
        const d = decideAppCall(
            { tool: 'ForceTheQuestion' },
            grant({ capabilities: ['ask'] }),
        );

        expect(d.allowed).toBe(true);
        expect(d.mustAttribute).toBe(true);
        expect(d.appName).toBe('Example Trader');
    });

    it('does not ask for attribution on a call the user never sees', () => {
        expect(decideAppCall({ tool: 'manageSite' }, grant()).mustAttribute).toBeUndefined();
    });
});
