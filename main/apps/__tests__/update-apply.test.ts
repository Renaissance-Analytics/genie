import { describe, expect, it, vi } from 'vitest';
import { updateAppFromFolder, type AppInstallIO } from '../install';
import { validateAppManifest, type AppManifest } from '../manifest';
import type { InstalledAppVersion } from '../updates';

/**
 * APPLYING an update to an installed GApp (Tynn #250).
 *
 * The owner's requirement is that a GApp updates on its own lifecycle without a
 * Genie release. The security model's requirement is that a version asking for
 * more than the user granted goes back through consent. This is where the two
 * meet, and the assertions that matter are about calls that must NOT happen:
 *
 *   - a QUIET update must not open the consent modal, and
 *   - it must record the SAME grant it had — a quiet update that widened the grant
 *     would be the escalation path this whole design exists to close.
 *
 * The decision is re-run HERE, from the manifest, rather than passed in by the
 * caller. That is the point: a "skip consent" argument would be a security
 * decision made somewhere it cannot be reviewed, and would be one bug away from
 * being wrong.
 */

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const manifestJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.1.0',
        frontend: { repo: 'desktop', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: ['hosting', 'knowledge'] },
        ...over,
    });

const parsed = (raw: string): AppManifest => {
    const result = validateAppManifest(JSON.parse(raw));
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.value;
};

/** The installed copy: it asked for two capabilities, the user ticked one. */
const installed = (over: Partial<InstalledAppVersion> = {}): InstalledAppVersion => ({
    id: 'com.example.trader',
    source: { kind: 'github', origin: 'github.com/acme/trader', commit: 'old0000' },
    capabilities: ['hosting'],
    scope: 'self',
    workspaces: [],
    declared: parsed(manifestJson({ version: '1.0.0' })),
    devMode: false,
    revoked: false,
    ...over,
});

const io = (over: Partial<AppInstallIO> = {}): AppInstallIO => ({
    readManifest: () => manifestJson(),
    machine: async () => ({ installed: new Set(['node']), canInstall: () => true }),
    ask: async () => ({
        cancelled: false,
        answers: [
            { header: 'Install', question: '', selected: ['Install'], note: '' },
            {
                header: 'Permissions',
                question: '',
                selected: ['Host sites and services', "Genie's memory"],
                note: '',
            },
        ],
    }),
    existingApp: () => ({
        workspaceId: 'ws-app',
        path: 'C:/apps/trader.agi',
        source: { kind: 'github', origin: 'github.com/acme/trader', commit: 'old0000' },
    }),
    createWorkspace: async () => ({ workspaceId: 'ws-new', path: 'C:/apps/new' }),
    adoptFolder: async () => ({ workspaceId: 'ws-dev', path: 'C:/src/trader' }),
    copyAppSource: () => {},
    persistSites: () => {},
    recordGrant: () => {},
    removeWorkspace: () => {},
    ...over,
});

const arriving = { origin: 'github.com/acme/trader', announcedCommit: COMMIT, commit: COMMIT };

describe('a quiet update', () => {
    it('applies without opening the consent modal', async () => {
        // The requirement, plainly: a fix reaches the user without a Genie release
        // and without a screen that has nothing new to say.
        const ask = vi.fn();
        const result = await updateAppFromFolder('C:/tmp/fetched', io({ ask }), {
            installed: installed(),
            arriving,
        });

        expect(result.ok).toBe(true);
        expect(result.applied).toBe('quiet');
        expect(ask).not.toHaveBeenCalled();
    });

    it('records the SAME capabilities it already had, never the new declaration', async () => {
        // The property the whole design rests on. The arriving manifest declares
        // `knowledge` as well as `hosting`; the user only ever granted `hosting`.
        const recordGrant = vi.fn();
        await updateAppFromFolder('C:/tmp/fetched', io({ recordGrant }), {
            installed: installed(),
            arriving,
        });

        expect(recordGrant).toHaveBeenCalledTimes(1);
        expect(recordGrant.mock.calls[0][0].capabilities).toEqual(['hosting']);
        expect(recordGrant.mock.calls[0][0].scope).toBe('self');
    });

    it('records the NEW version and the commit it verified', async () => {
        // Provenance has to move with the app, or the next update compares against
        // a version that is no longer on the machine.
        const recordGrant = vi.fn();
        await updateAppFromFolder('C:/tmp/fetched', io({ recordGrant }), {
            installed: installed(),
            arriving,
        });

        const grant = recordGrant.mock.calls[0][0];
        expect(grant.version).toBe('1.1.0');
        expect(grant.source).toEqual({
            kind: 'github',
            origin: 'github.com/acme/trader',
            commit: COMMIT,
        });
    });

    it('leaves a REVOKED app revoked', async () => {
        // Revoking is how a user turns an app's permissions off without removing
        // it. An update that quietly switched them back on would make revocation
        // last exactly until the app's next commit.
        const recordGrant = vi.fn();
        await updateAppFromFolder('C:/tmp/fetched', io({ recordGrant }), {
            installed: installed({ revoked: true }),
            arriving,
        });

        expect(recordGrant.mock.calls[0][0].revoked).toBe(true);
    });

    it('stays in the workspace the app already has', async () => {
        // An update that created a second workspace would orphan the first, with
        // the user's data in it.
        const createWorkspace = vi.fn();
        const recordGrant = vi.fn();
        await updateAppFromFolder('C:/tmp/fetched', io({ createWorkspace, recordGrant }), {
            installed: installed(),
            arriving,
        });

        expect(createWorkspace).not.toHaveBeenCalled();
        expect(recordGrant.mock.calls[0][0].workspaceId).toBe('ws-app');
    });
});

describe('an update that asks for something new', () => {
    const wantsMore = () => manifestJson({ permissions: { scope: 'workstation', capabilities: ['hosting', 'terminals'] } });

    it('goes through the consent modal instead', async () => {
        const ask = vi.fn(async () => ({
            cancelled: false,
            answers: [{ header: 'Install', question: '', selected: ['Install'], note: '' }],
        }));

        const result = await updateAppFromFolder(
            'C:/tmp/fetched',
            io({ readManifest: wantsMore, ask }),
            { installed: installed(), arriving },
        );

        expect(ask).toHaveBeenCalled();
        expect(result.applied).toBe('consent');
    });

    it('changes NOTHING when the user dismisses that modal', async () => {
        // A declined update leaves the working version exactly where it was.
        const recordGrant = vi.fn();
        const copyAppSource = vi.fn();
        const result = await updateAppFromFolder(
            'C:/tmp/fetched',
            io({
                readManifest: wantsMore,
                ask: async () => ({ cancelled: true, answers: [] }),
                recordGrant,
                copyAppSource,
            }),
            { installed: installed(), arriving },
        );

        expect(result.ok).toBe(false);
        expect(recordGrant).not.toHaveBeenCalled();
        expect(copyAppSource).not.toHaveBeenCalled();
    });
});

describe('an update Genie refuses outright', () => {
    it('applies nothing when the commit that arrived is not the one checked', async () => {
        const recordGrant = vi.fn();
        const copyAppSource = vi.fn();
        const ask = vi.fn();
        const result = await updateAppFromFolder(
            'C:/tmp/fetched',
            io({ recordGrant, copyAppSource, ask }),
            {
                installed: installed(),
                arriving: { ...arriving, commit: 'ffff999999999999999999999999999999999999' },
            },
        );

        expect(result.ok).toBe(false);
        expect(result.applied).toBe('blocked');
        expect(recordGrant).not.toHaveBeenCalled();
        expect(copyAppSource).not.toHaveBeenCalled();
        // Not even asked. A blocked update is not a decision to put to the user —
        // there is nothing they could usefully say yes to.
        expect(ask).not.toHaveBeenCalled();
    });

    it('refuses a manifest that will not parse, before touching anything', async () => {
        const copyAppSource = vi.fn();
        const result = await updateAppFromFolder(
            'C:/tmp/fetched',
            io({ readManifest: () => '{ not json', copyAppSource }),
            { installed: installed(), arriving },
        );

        expect(result.ok).toBe(false);
        expect(copyAppSource).not.toHaveBeenCalled();
    });
});
