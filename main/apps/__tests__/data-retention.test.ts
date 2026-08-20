import { describe, expect, it } from 'vitest';
import { decideStorageOnInstall, uninstallDataQuestion } from '../data-retention';

/**
 * Does a reinstalled GApp get its data back? (Tynn #250, owner-directed)
 *
 * The owner's rule: **uninstall should PROMPT to clear the data store and
 * settings, and reinstalling should restore the app's access to them.** That is
 * plainly right — losing everything because you removed an app for a fortnight is
 * hostile — and it is in direct tension with the rule I shipped last night, which
 * wiped an app id's storage on every fresh install.
 *
 * The tension is real, not imagined. An app id is claimed by whoever writes the
 * manifest, so "restore the data to whatever installs under this id next" is
 * exactly how a stranger's fork walks off with somebody's session.
 *
 * PROVENANCE is what resolves it. Data is kept for an app FROM A PARTICULAR
 * ORIGIN. Reinstall from the same place and it comes back; install from somewhere
 * else and it is wiped, because that is not the same app — it merely claims the
 * same name.
 */

const retained = (origin: string) => ({ origin });
const from = (origin: string) => ({ kind: 'github' as const, origin });

describe('reinstalling something you removed', () => {
    it('KEEPS the data when it comes back from the same place', () => {
        const d = decideStorageOnInstall({
            retained: retained('github.com/acme/trader'),
            incoming: from('github.com/acme/trader'),
        });

        expect(d.clear).toBe(false);
        expect(d.reason).toMatch(/restor/i);
    });

    it('keeps it for a local folder reinstalled from the same folder', () => {
        const d = decideStorageOnInstall({
            retained: retained('C:/src/trader'),
            incoming: { origin: 'C:/src/trader' },
        });
        expect(d.clear).toBe(false);
    });
});

describe('an app id being claimed by somebody else', () => {
    it('WIPES the data when the origin does not match', () => {
        // The whole point. Restoring here would hand a stranger's fork the
        // session, tokens and settings of the app it is impersonating.
        const d = decideStorageOnInstall({
            retained: retained('github.com/acme/trader'),
            incoming: from('github.com/evil/trader'),
        });

        expect(d.clear).toBe(true);
        expect(d.reason).toMatch(/different/i);
    });

    it('wipes when the retained data has no origin to vouch for it', () => {
        // Data left by an app installed before Genie recorded provenance cannot be
        // matched to anything. Unmatched means unproven, and unproven means wiped.
        const d = decideStorageOnInstall({
            retained: { origin: '' },
            incoming: from('github.com/acme/trader'),
        });
        expect(d.clear).toBe(true);
    });

    it('wipes when the incoming install has no recorded origin either', () => {
        const d = decideStorageOnInstall({
            retained: retained('github.com/acme/trader'),
            incoming: null,
        });
        expect(d.clear).toBe(true);
    });
});

describe('a genuinely fresh app id', () => {
    it('starts clean, because nothing was kept for it', () => {
        const d = decideStorageOnInstall({ retained: null, incoming: from('github.com/acme/x') });

        expect(d.clear).toBe(true);
        expect(d.reason).toMatch(/nothing was kept|fresh/i);
    });
});

describe('an UPDATE, not a reinstall', () => {
    it('never touches the data of an app that is still installed', () => {
        // Updating an app the user still has is not a fresh arrival at all, and
        // wiping a user's data because they updated would be far worse than the
        // bug any of this guards against.
        const d = decideStorageOnInstall({
            stillInstalled: true,
            retained: null,
            incoming: from('github.com/acme/trader'),
        });

        expect(d.clear).toBe(false);
        expect(d.reason).toMatch(/update/i);
    });
});

describe('what uninstall asks', () => {
    it('offers to keep the data, and says what keeping means', () => {
        const q = uninstallDataQuestion('Example Trader');

        expect(q.options).toHaveLength(2);
        expect(JSON.stringify(q)).toMatch(/keep/i);
        // The user needs to know keeping is not forever-orphaned: it comes back.
        expect(JSON.stringify(q)).toMatch(/reinstall/i);
    });

    it('names the app, so it cannot be answered about the wrong one', () => {
        expect(JSON.stringify(uninstallDataQuestion('Example Trader'))).toContain(
            'Example Trader',
        );
    });

    it('does not make deleting the accidental default', () => {
        // Dismissing the modal must not destroy data. The keep option leads.
        expect(uninstallDataQuestion('X').options[0]?.label).toMatch(/keep/i);
    });
});
