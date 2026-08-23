import { describe, expect, it } from 'vitest';
import { decideAppUpdate, type ArrivingVersion, type InstalledAppVersion } from '../updates';
import { validateAppManifest, type AppManifest } from '../manifest';

/**
 * May this new version be applied WITHOUT asking again? (Tynn #250)
 *
 * The owner's requirement: "GApps do have integrity checking and should be able to
 * detect and install updates without Genie receiving any updates. GApps will have
 * their own development lifecycle." The security model already built says the
 * opposite-looking thing: an update goes back through review and consent, because
 * a new version can ask for more than the user granted.
 *
 * Both are honoured by deciding, from data, which of the two an arriving version
 * is. That decision lives here — pure, and re-run INSIDE the installer, so no
 * caller can pass a "skip consent" flag. A flag would be the escalation path with
 * a friendly name; a decision made from the manifest is not.
 *
 * ## The property that makes the quiet path safe
 *
 * A quiet update NEVER changes the grant. The app keeps exactly the capabilities
 * and reach the user already agreed to, so its authority cannot grow by updating,
 * whatever its new manifest declares. Consent is therefore not a lock on the code
 * changing — it is how the user is shown something NEW being asked of them.
 *
 * Everything below is fail-closed: an unverifiable commit blocks, an unrecognised
 * shape blocks, and anything that cannot be shown to be safe goes back to consent
 * rather than through.
 */

const declared = (over: Record<string, unknown> = {}): AppManifest => {
    const result = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'desktop', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: ['hosting'] },
        ...over,
    });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.value;
};

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const installed = (over: Partial<InstalledAppVersion> = {}): InstalledAppVersion => ({
    id: 'com.example.trader',
    source: { kind: 'github', origin: 'github.com/acme/trader', commit: 'old0000' },
    capabilities: ['hosting'],
    scope: 'self',
    workspaces: [],
    declared: declared(),
    devMode: false,
    revoked: false,
    ...over,
});

const arriving = (over: Partial<ArrivingVersion> = {}): ArrivingVersion => ({
    origin: 'github.com/acme/trader',
    announcedCommit: COMMIT,
    commit: COMMIT,
    manifest: declared({ version: '1.1.0' }),
    ...over,
});

describe('the quiet path — an app updating on its own lifecycle', () => {
    it('lets a version that asks for nothing new through, with no modal', () => {
        // This is the requirement. A bug fixed on Tuesday reaches the user without
        // a Genie release and without a consent screen that has nothing to say.
        expect(decideAppUpdate(installed(), arriving()).kind).toBe('quiet');
    });

    it('lets a version through that asks for LESS than before', () => {
        // An app dropping a permission is the direction nobody needs protecting
        // from, and stopping to confirm it would teach people to click through.
        const decision = decideAppUpdate(
            installed(),
            arriving({ manifest: declared({ permissions: { scope: 'self', capabilities: [] } }) }),
        );

        expect(decision.kind).toBe('quiet');
    });

    it('does not re-ask for something the user was already shown and declined', () => {
        // Installed asking for hosting AND knowledge; the user ticked only hosting.
        // The app goes on declaring both, because that is what it is for.
        //
        // Re-consenting every single update would make this app permanently
        // un-updatable and teach its user to click through the one screen that
        // matters. It is safe because a quiet update carries the grant forward
        // UNCHANGED — `knowledge` stays ungranted, and the app gains nothing.
        const decision = decideAppUpdate(
            installed({
                capabilities: ['hosting'],
                declared: declared({
                    permissions: { scope: 'self', capabilities: ['hosting', 'knowledge'] },
                }),
            }),
            arriving({
                manifest: declared({
                    version: '1.1.0',
                    permissions: { scope: 'self', capabilities: ['hosting', 'knowledge'] },
                }),
            }),
        );

        expect(decision.kind).toBe('quiet');
    });
});

describe('what sends an update back through consent', () => {
    const reasons = (d: ReturnType<typeof decideAppUpdate>) =>
        'reasons' in d ? d.reasons.join(' ') : '';

    it('a capability the user has never been shown', () => {
        const decision = decideAppUpdate(
            installed(),
            arriving({
                manifest: declared({
                    permissions: { scope: 'self', capabilities: ['hosting', 'terminals'] },
                }),
            }),
        );

        expect(decision.kind).toBe('consent');
        // Named, because "it wants more" is not a decision anybody can make.
        expect(reasons(decision)).toContain('terminals');
    });

    it('a WIDER reach than was granted', () => {
        const decision = decideAppUpdate(
            installed(),
            arriving({
                manifest: declared({
                    permissions: { scope: 'workstation', capabilities: ['hosting'] },
                }),
            }),
        );

        expect(decision.kind).toBe('consent');
        expect(reasons(decision)).toMatch(/workstation/i);
    });

    it('a workspace by name that was not in the granted list', () => {
        const decision = decideAppUpdate(
            installed({
                scope: 'workspaces',
                workspaces: ['ws-research'],
                declared: declared({
                    permissions: {
                        scope: 'workspaces',
                        workspaces: ['ws-research'],
                        capabilities: ['hosting'],
                    },
                }),
            }),
            arriving({
                manifest: declared({
                    permissions: {
                        scope: 'workspaces',
                        workspaces: ['ws-research', 'ws-payroll'],
                        capabilities: ['hosting'],
                    },
                }),
            }),
        );

        expect(decision.kind).toBe('consent');
        expect(reasons(decision)).toContain('ws-payroll');
    });

    it('NEWLY asking to be reachable from the real browser', () => {
        // It installs a certificate and edits the hosts file. That is a one-time
        // admin prompt the user agreed to once or not at all.
        const decision = decideAppUpdate(
            installed(),
            arriving({
                manifest: declared({
                    frontend: {
                        repo: 'desktop',
                        serve: { mode: 'static', root: 'dist' },
                        browserExposed: true,
                    },
                }),
            }),
        );

        expect(decision.kind).toBe('consent');
        expect(reasons(decision)).toMatch(/browser/i);
    });

    it('a DIFFERENT origin, however ordinary the manifest looks', () => {
        // An app id is claimed by whoever writes the manifest. A stranger's fork
        // stepping into the shoes of an app the user installed on purpose is the
        // loudest thing on the install screen, and an update must not be a way
        // round it.
        const decision = decideAppUpdate(
            installed(),
            arriving({ origin: 'github.com/attacker/trader' }),
        );

        expect(decision.kind).toBe('consent');
        expect(reasons(decision)).toContain('github.com/attacker/trader');
    });
});

describe('integrity — what arrived has to be what was announced', () => {
    it('BLOCKS when the commit that arrived is not the one resolved', () => {
        // The gap this closes is a ref moving between the check and the fetch: the
        // user is shown one commit and a different one lands. Git's sha is a hash
        // of the whole tree, so this is content integrity against the recorded
        // commit — reachable today, with no store and no signing.
        const decision = decideAppUpdate(
            installed(),
            arriving({ commit: 'ffff9999999999999999999999999999999999ff' }),
        );

        expect(decision.kind).toBe('blocked');
    });

    it('accepts the short and long forms of the SAME commit', () => {
        // `ls-remote` returns the full sha; what is recorded may be either form,
        // and a length mismatch must never read as tampering.
        expect(
            decideAppUpdate(installed(), arriving({ announcedCommit: COMMIT.slice(0, 7) })).kind,
        ).toBe('quiet');
    });

    it('BLOCKS when there is no commit to verify against', () => {
        // Unverifiable is not the same as fine. Applying a version Genie cannot
        // identify would make the recorded provenance a guess.
        for (const over of [{ commit: '' }, { announcedCommit: '' }]) {
            expect(decideAppUpdate(installed(), arriving(over)).kind).toBe('blocked');
        }
    });

    it('BLOCKS a manifest that is not the same app at all', () => {
        const decision = decideAppUpdate(
            installed(),
            arriving({ manifest: declared({ id: 'com.attacker.other' }) }),
        );

        expect(decision.kind).toBe('blocked');
    });
});

describe('apps Genie must not update at all', () => {
    it('BLOCKS a dev-mode app, which runs from a folder the developer owns', () => {
        // Its workspace IS the source folder being edited. Overwriting it would
        // destroy uncommitted work, and the developer already has git.
        const decision = decideAppUpdate(installed({ devMode: true }), arriving());

        expect(decision.kind).toBe('blocked');
    });

    it('BLOCKS an app that was never installed from a repo', () => {
        // A folder install has no upstream. There is no version to compare, so
        // there is nothing to verify what arrived against.
        for (const source of [
            null,
            { kind: 'folder' as const, origin: 'C:/src/trader' },
            { kind: 'github' as const, origin: 'github.com/acme/trader' },
        ]) {
            expect(decideAppUpdate(installed({ source }), arriving()).kind).toBe('blocked');
        }
    });
});
