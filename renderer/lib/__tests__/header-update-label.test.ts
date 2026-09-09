import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { headerUpdateLabel } from '../updater-flow';

/**
 * THE GENIE LABEL IS THE UPDATE CONTROL (genie#565).
 *
 * The owner's ask, verbatim: *"remove the double Update and Restart buttons
 * showing up in the UX. we only need the one in the header. Also, move that
 * button over to the Genie header label in the header. when that button isn't
 * there it should show the version and if an upgrade is available it says
 * 'Upgrade to {version}'"*
 *
 * So the wordmark is never idle chrome: it is either telling you what you are
 * running or offering you the thing you would click. Which of those it is, and
 * the exact words, is decided here rather than in the component — the states
 * are the whole feature and there are more of them than a reader would guess.
 */

const base = {
    currentVersion: '0.7.0-beta.304',
    latestVersion: null as string | null,
    manualDownloadUrl: null as string | null,
    committed: false,
    progress: null as number | null,
    heldTerminals: 0,
    heldChats: 0,
};

describe('with nothing to install, the label IS the version', () => {
    it('shows the running version when up to date', () => {
        expect(headerUpdateLabel({ ...base, state: 'up-to-date' })).toEqual({
            kind: 'version',
            text: 'v0.7.0-beta.304',
        });
    });

    it('shows the version before any check has reported', () => {
        expect(headerUpdateLabel({ ...base, state: null })).toEqual({
            kind: 'version',
            text: 'v0.7.0-beta.304',
        });
    });

    it('shows the version rather than an error the user cannot act on', () => {
        // A failed check is the updater's problem. The label's job in that
        // moment is still to say what is running.
        expect(headerUpdateLabel({ ...base, state: 'error' }).kind).toBe('version');
    });
});

describe('with an update available, the label IS the button', () => {
    it('reads "Upgrade to v{version}"', () => {
        expect(
            headerUpdateLabel({
                ...base,
                state: 'available',
                latestVersion: '0.7.0-beta.305',
            }),
        ).toEqual({ kind: 'upgrade', text: 'Upgrade to v0.7.0-beta.305' });
    });

    it('offers a PRE-STAGED build the same way — one click still commits', () => {
        // A build already downloaded and sitting at ready-to-restart is just as
        // actionable as one that has not been fetched. This is the state the
        // deleted banner used to be the only affordance for.
        expect(
            headerUpdateLabel({
                ...base,
                state: 'ready-to-restart',
                latestVersion: '0.7.0-beta.305',
            }).kind,
        ).toBe('upgrade');
    });

    it('names the NEW version, never the running one', () => {
        // The positive control for the pair above: the two branches must not
        // collapse into the same string, or "Upgrade to…" would be telling the
        // user to upgrade to what they already have.
        const idle = headerUpdateLabel({ ...base, state: 'up-to-date' });
        const offered = headerUpdateLabel({
            ...base,
            state: 'available',
            latestVersion: '0.7.0-beta.305',
        });
        expect(offered.text).not.toBe(idle.text);
        expect(offered.text).toContain('0.7.0-beta.305');
        expect(offered.text).not.toContain('beta.304');
    });

    it('falls back to the running version when the new one is unnamed', () => {
        // "Upgrade to v" with nothing after it is worse than saying nothing.
        const label = headerUpdateLabel({ ...base, state: 'available', latestVersion: null });
        expect(label.text).not.toMatch(/v\s*$/);
    });
});

describe('the states between click and restart', () => {
    it('shows progress once committed, and offers no second click', () => {
        expect(
            headerUpdateLabel({
                ...base,
                state: 'downloading',
                latestVersion: '0.7.0-beta.305',
                committed: true,
                progress: 0.42,
            }),
        ).toEqual({ kind: 'progress', text: 'Downloading… 42%' });
    });

    it('says what it is doing even with no percentage yet', () => {
        expect(
            headerUpdateLabel({
                ...base,
                state: 'downloading',
                latestVersion: '0.7.0-beta.305',
                committed: true,
                progress: null,
            }),
        ).toEqual({ kind: 'progress', text: 'Downloading…' });
    });

    it('reports the restart it is waiting on', () => {
        expect(
            headerUpdateLabel({
                ...base,
                state: 'ready-to-restart',
                latestVersion: '0.7.0-beta.305',
                committed: true,
            }),
        ).toEqual({ kind: 'progress', text: 'Restarting…' });
    });
});

describe('a HELD restart asks, it does not proceed', () => {
    it('offers the drain when live work would be torn down', () => {
        const label = headerUpdateLabel({
            ...base,
            state: 'ready-to-restart',
            latestVersion: '0.7.0-beta.305',
            heldTerminals: 3,
            heldChats: 2,
        });
        expect(label.kind).toBe('held');
        expect(label.text).toContain('2');
    });

    it('a held build stays held even after the user committed', () => {
        // The backend disarmed its hands-free apply; the pill must not quietly
        // render "Restarting…" over a restart that is not happening.
        expect(
            headerUpdateLabel({
                ...base,
                state: 'ready-to-restart',
                latestVersion: '0.7.0-beta.305',
                committed: true,
                heldTerminals: 1,
                heldChats: 1,
            }).kind,
        ).toBe('held');
    });
});

describe('a build this platform cannot auto-install', () => {
    it('offers the download instead of an upgrade it cannot perform', () => {
        const label = headerUpdateLabel({
            ...base,
            state: 'available',
            latestVersion: '0.7.0-beta.305',
            manualDownloadUrl: 'https://example.invalid/release',
        });
        expect(label.kind).toBe('download');
        expect(label.text).toContain('0.7.0-beta.305');
    });
});

/**
 * ONE CONTROL, IN THE HEADER.
 *
 * `UpdateReadyBanner` and `UpdatePill` both rendered for the SAME
 * `ready-to-restart` state and both called `updater.restart()` — the double
 * button the owner asked to remove. Asserted against the source because the
 * duplication is a fact about the page's structure, and a component that no
 * longer exists cannot be rendered to prove its own absence.
 */
describe('the duplicate update control is gone', () => {
    const master = readFileSync(
        path.resolve(__dirname, '../../pages/master.tsx'),
        'utf8',
    );

    it('reads the file it claims to be checking', () => {
        // The positive control. "X is absent" passes just as well on an empty
        // string or a path typo, so prove the corpse is warm first.
        expect(master.length).toBeGreaterThan(10_000);
        expect(master).toContain('UpdatePill');
    });

    it('has no UpdateReadyBanner left, in any form', () => {
        expect(master).not.toContain('UpdateReadyBanner');
        expect(master).not.toContain('update-banner');
    });

    it('renders the update control exactly ONCE', () => {
        expect(master.match(/<UpdatePill\b/g) ?? []).toHaveLength(1);
    });

    it('renders it on the Genie wordmark, not loose in the title bar', () => {
        // Sliced between the two function declarations rather than by line, so
        // the guard is indifferent to the file's CRLF endings.
        const corner = master.slice(
            master.indexOf('function AppCorner('),
            master.indexOf('function TitleBar('),
        );
        expect(corner.length).toBeGreaterThan(200);
        expect(corner).toContain('<UpdatePill');
        expect(corner).toContain('glogo');
    });
});

/**
 * WHILE THE AGENTS ARE BEING ASKED, SAY SO (genie#565).
 *
 * The hands-free apply now goes through the drain, so `ready-to-restart` +
 * committed no longer means "restarting" — it routinely means "holding, while
 * every live agent finishes and hands off". The roster flyout shows who; the
 * label must not meanwhile narrate a restart that is not happening.
 */
describe('the label tells the truth during a drain', () => {
    const committedReady = {
        ...base,
        state: 'ready-to-restart',
        latestVersion: '0.7.0-beta.305',
        committed: true,
    };

    it('says "Restarting…" when no drain is holding it', () => {
        // The control. Without this the assertion below would pass against a
        // build that had simply changed the word.
        expect(headerUpdateLabel(committedReady)).toEqual({
            kind: 'progress',
            text: 'Restarting…',
        });
    });

    it('counts the agents still to answer', () => {
        expect(
            headerUpdateLabel({
                ...committedReady,
                draining: { active: true, total: 3, green: 1 },
            }),
        ).toEqual({ kind: 'progress', text: 'Waiting on 2 agents' });
    });

    it('reads singular for the last one', () => {
        expect(
            headerUpdateLabel({
                ...committedReady,
                draining: { active: true, total: 3, green: 2 },
            }).text,
        ).toBe('Waiting on 1 agent');
    });

    it('turns back into a restart once the roster is green', () => {
        // The drain has cleared and the apply is on its way — the label must
        // not sit on "Waiting on 0 agents".
        expect(
            headerUpdateLabel({
                ...committedReady,
                draining: { active: true, total: 3, green: 3 },
            }).text,
        ).toBe('Restarting…');
    });

    it('ignores a drain that is not running', () => {
        expect(
            headerUpdateLabel({
                ...committedReady,
                draining: { active: false, total: 3, green: 0 },
            }).text,
        ).toBe('Restarting…');
    });
});
