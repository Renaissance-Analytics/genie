import { describe, expect, it } from 'vitest';
import { grantableCapabilities, narrowGrant } from '../manage-core';
import { appRequirements } from '../manage';

/**
 * Changing what an installed app may do, after it is installed (Tynn #250).
 *
 * The permissions screen is the second place a grant can change, and it is the one
 * that is NOT behind an OS modal — it is ordinary UI, in Genie's own renderer. So
 * the rule it has to enforce is the one the consent modal enforces structurally:
 * a grant may only ever be a SUBSET of what the manifest declared.
 *
 * That is not defence against the user — it is their machine and their choice. It
 * is defence against everything between the manifest and the store: a bug in the
 * screen, a stale list after an update that asked for less, a renderer that has
 * been made to send something it should not.
 */

const declared = ['hosting', 'knowledge', 'terminals'];

describe('what the permissions screen may offer', () => {
    it('offers exactly what the app asked for', () => {
        const offered = grantableCapabilities(declared).map((c) => c.key);
        expect(offered).toEqual(['terminals', 'hosting', 'knowledge']);
    });

    it('puts the riskiest first, where it will be read', () => {
        // A list that buries "Run commands" under "Open files for you" is a list
        // that got skimmed.
        expect(grantableCapabilities(declared)[0]?.risk).toBe('high');
    });

    it('drops a capability that no longer exists', () => {
        // An app installed under an older Genie can name a capability this build
        // has removed. Showing an unrecognised toggle would be offering a switch
        // wired to nothing.
        expect(grantableCapabilities([...declared, 'telepathy']).map((c) => c.key)).not.toContain(
            'telepathy',
        );
    });

    it('offers nothing for an app that asked for nothing', () => {
        expect(grantableCapabilities([])).toEqual([]);
    });
});

describe('what a change may actually grant', () => {
    it('keeps what the user chose', () => {
        expect(narrowGrant(declared, ['hosting'])).toEqual(['hosting']);
    });

    it('refuses to grant beyond the manifest', () => {
        // The load-bearing one. An app that never asked for `secrets` cannot be
        // given `secrets` by anything short of a reinstall, where the user is
        // asked properly.
        expect(narrowGrant(declared, ['hosting', 'secrets'])).toEqual(['hosting']);
    });

    it('refuses a capability that does not exist', () => {
        expect(narrowGrant([...declared, 'telepathy'], ['telepathy'])).toEqual([]);
    });

    it('drops duplicates', () => {
        expect(narrowGrant(declared, ['hosting', 'hosting'])).toEqual(['hosting']);
    });

    it('accepts granting nothing', () => {
        // Turning everything off is a legitimate answer, and distinct from
        // uninstalling: the app stays, and stops being able to call Genie.
        expect(narrowGrant(declared, [])).toEqual([]);
    });

    it('survives junk without granting any of it', () => {
        expect(narrowGrant(declared, [null, 42, '', {}, 'hosting'] as unknown as string[])).toEqual([
            'hosting',
        ]);
    });

    it('keeps the manifest’s order, not the caller’s', () => {
        // So the stored grant is comparable between reads, and a reordered payload
        // is not a different grant.
        expect(narrowGrant(declared, ['knowledge', 'hosting'])).toEqual(['hosting', 'knowledge']);
    });
});

describe('what an installed app still needs from this machine', () => {
    it('is DERIVED from the stored manifest, never a snapshot taken at install', async () => {
        // The machine changes. A user who installs Rust after the fact should stop
        // being told to install Rust, and a stored "you must provide" list would
        // keep nagging them forever.
        const manifest = JSON.stringify({
            requires: [{ tool: 'rust', reason: 'compiles the engine' }],
        });

        const before = await appRequirements(manifest, {
            installed: new Set<string>(),
            canInstall: () => false,
        });
        expect(before.userProvides.map((r) => r.tool)).toEqual(['rust']);

        const after = await appRequirements(manifest, {
            installed: new Set(['rust']),
            canInstall: () => false,
        });
        expect(after.userProvides).toEqual([]);
        expect(after.items[0]?.status).toBe('satisfied');
    });

    it('asks nothing of an app that requires nothing', async () => {
        const plan = await appRequirements(JSON.stringify({}), {
            installed: new Set<string>(),
            canInstall: () => false,
        });
        expect(plan.items).toEqual([]);
    });

    it('treats a manifest it cannot read as requiring nothing', async () => {
        // Fail QUIET here, not closed-and-loud: an unreadable manifest is already
        // reported elsewhere, and inventing requirements from a parse failure
        // would put a scary, wrong list in front of the user.
        const plan = await appRequirements('not json', {
            installed: new Set<string>(),
            canInstall: () => false,
        });
        expect(plan.items).toEqual([]);
    });
});
