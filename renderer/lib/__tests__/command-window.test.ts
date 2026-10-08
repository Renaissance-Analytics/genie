import { describe, expect, it } from 'vitest';
import {
    COMMAND_PREFIXES,
    filterCommandItems,
    dropUndeliverable,
    groupCommandItems,
    parseCommandQuery,
    type CommandItem,
} from '../command-window';

/**
 * The Command Window's judgement (Tynn story #247) — everything except the pixels.
 *
 * The palette itself is Fancy's `Command` (react-fancy already ships it, and
 * Genie already depends on it), so this file owns only what Fancy cannot know:
 * which of Genie's things are offered, and how a typed query narrows them.
 *
 * The type-ahead PREFIXES are the part worth testing hard. `p> ` means "prompts
 * only" — but a bare `p` is someone starting to type "php", and swallowing that
 * as a filter would make the palette feel like it is fighting you. So a prefix is
 * only a prefix when it is complete.
 */

const ITEMS: CommandItem[] = [
    { id: 'ws-1', category: 'workspace', label: 'Tynn.ai' },
    { id: 'ws-2', category: 'workspace', label: 'Prism Sandbox' },
    { id: 'term-1', category: 'terminal', label: 'claude — repos/tynn' },
    { id: 'prompt-1', category: 'prompt', label: 'Run the test suite' },
    { id: 'prompt-2', category: 'prompt', label: 'Summarise what you changed' },
    { id: 'panel-1', category: 'panel', label: 'Site Manager' },
];

describe('parsing a typed query', () => {
    it('reads a complete prefix as a category filter', () => {
        expect(parseCommandQuery('p> test')).toEqual({ category: 'prompt', text: 'test' });
        expect(parseCommandQuery('w> tynn')).toEqual({ category: 'workspace', text: 'tynn' });
    });

    it('accepts a prefix with nothing after it yet', () => {
        // `p>` alone means "show me every prompt" — the browse case, and the
        // moment right before typing a filter.
        expect(parseCommandQuery('p>')).toEqual({ category: 'prompt', text: '' });
        expect(parseCommandQuery('p> ')).toEqual({ category: 'prompt', text: '' });
    });

    it('does NOT treat a bare letter as a prefix', () => {
        // Someone typing "php" starts with "p". Eating that would make the
        // palette feel like it is fighting the user.
        expect(parseCommandQuery('p')).toEqual({ category: null, text: 'p' });
        expect(parseCommandQuery('php')).toEqual({ category: null, text: 'php' });
    });

    it('ignores an unknown prefix rather than filtering everything away', () => {
        // `z>` matches no category. Silently returning nothing would read as a
        // broken palette; treating it as literal text at least searches.
        expect(parseCommandQuery('z> thing')).toEqual({ category: null, text: 'z> thing' });
    });

    it('is case-insensitive and tolerates surrounding space', () => {
        expect(parseCommandQuery('  W> Tynn ')).toEqual({ category: 'workspace', text: 'Tynn' });
    });

    it('has a prefix for every category it offers', () => {
        // A category with no prefix is unreachable by keyboard, which defeats a
        // keyboard-first palette.
        const categories = new Set(ITEMS.map((i) => i.category));
        for (const category of categories) {
            expect(Object.values(COMMAND_PREFIXES)).toContain(category);
        }
    });
});

/**
 * ACTIONS — the palette's answer to "how do I launch a GApp from its GDW?"
 * (genie#245 follow-on).
 *
 * The honest answer used to be "two clicks, if you know where to look": open
 * Workspace Settings, scroll to a section that only exists on a GDW, press
 * Preview. Nothing in the rail, nothing in the palette. A verb reachable only by
 * knowing where it is hiding is not reachable.
 *
 * `action` is a general category, not a GApp one — the palette is where Genie's
 * verbs go, and this is the first of them.
 */
describe('actions are offered like anything else', () => {
    const WITH_ACTION: CommandItem[] = [
        ...ITEMS,
        {
            id: 'gapp-preview:ws-1',
            category: 'action',
            label: 'Launch Weather (Genie App)',
            hint: 'Tynn.ai',
        },
    ];

    it('has a type-ahead prefix, like every other category', () => {
        expect(Object.values(COMMAND_PREFIXES)).toContain('action');
    });

    it('narrows to actions on that prefix', () => {
        const shown = filterCommandItems(WITH_ACTION, parseCommandQuery('a>'));
        expect(shown.map((i) => i.id)).toEqual(['gapp-preview:ws-1']);
    });

    it('is findable by typing what it does, with no prefix at all', () => {
        // The whole point: someone who does not know the category exists still
        // finds the verb by typing the word for it.
        const shown = filterCommandItems(WITH_ACTION, parseCommandQuery('launch'));
        expect(shown.map((i) => i.id)).toEqual(['gapp-preview:ws-1']);
    });

    it('has a heading, so it reads as a section rather than loose rows', () => {
        const groups = groupCommandItems(WITH_ACTION);
        const actions = groups.find((g) => g.category === 'action');

        expect(actions?.heading).toBeTruthy();
        expect(actions?.items.map((i) => i.id)).toEqual(['gapp-preview:ws-1']);
    });

    it('does not appear when there are none — POSITIVE CONTROL', () => {
        // A permanently empty "Actions" heading would be worse than no category.
        const groups = groupCommandItems(ITEMS);

        expect(groups.find((g) => g.category === 'action')).toBeUndefined();
        // …and the same call still grouped everything else, so the absence above
        // is a real filter and not an empty render.
        expect(groups.map((g) => g.category)).toContain('workspace');
    });
});

describe('filtering', () => {
    it('offers everything for an empty query', () => {
        expect(filterCommandItems(ITEMS, parseCommandQuery('')).length).toBe(ITEMS.length);
    });

    it('narrows to one category on a prefix, without needing any text', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery('p>'));
        expect(shown.map((i) => i.id)).toEqual(['prompt-1', 'prompt-2']);
    });

    it('matches text case-insensitively, anywhere in the label', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery('sandbox'));
        expect(shown.map((i) => i.id)).toEqual(['ws-2']);
    });

    it('combines a category with its text', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery('p> summar'));
        expect(shown.map((i) => i.id)).toEqual(['prompt-2']);
    });

    it('searches across categories when no prefix is given', () => {
        // "tynn" is a workspace AND part of a terminal's cwd. A keyboard-first
        // palette should surface both rather than pick one.
        const shown = filterCommandItems(ITEMS, parseCommandQuery('tynn'));
        expect(shown.map((i) => i.id)).toEqual(['ws-1', 'term-1']);
    });

    it('returns nothing findable rather than everything when text matches none', () => {
        expect(filterCommandItems(ITEMS, parseCommandQuery('zzzz'))).toEqual([]);
    });

    it('keeps the given order, so the list does not reshuffle as you type', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery(''));
        expect(shown.map((i) => i.id)).toEqual(ITEMS.map((i) => i.id));
    });
});

describe('a REMOTE window is offered only what belongs to the machine it is driving', () => {
    /**
     * The rule the title-bar icons enforced, and nearly lost with them.
     *
     * `onShowSharing` was deliberately optional and withheld in a remote window — *"a share link is
     * scoped to the workstation that OWNS the workspace. Minting one from a window driving somebody
     * else's machine would hand out a link to the wrong workspace on the wrong host."* The Hosts
     * button refused to render at all in a host window, and `master.tsx` skips the Genie OS
     * first-run effect there for the same reason.
     *
     * Deleting the icons moved every one of those behind ⌘K, which had no notion of a remote
     * window — so a remote window could have minted a link for the wrong host from the palette.
     * `share-workspace-wiring.test.ts` caught it, which is exactly what it was written for.
     */
    const feature = (id: string): CommandItem => ({
        id: `feature:${id}`,
        category: 'panel',
        label: id,
        featureId: id,
    });

    const local = { hasTerminal: true, remote: false };
    const remote = { hasTerminal: true, remote: true };

    it('drops SHARING in a remote window', () => {
        const items = [feature('sharing'), feature('lists')];
        expect(dropUndeliverable(items, remote).map((i) => i.featureId)).toEqual(['lists']);
    });

    it('drops the HOSTS surface in a remote window', () => {
        // You are already driving someone else's machine; the host list is the local
        // workstation's, and the button it replaced refused to render there at all.
        expect(dropUndeliverable([feature('remote-host')], remote)).toEqual([]);
    });

    it('drops GENIE OS in a remote window', () => {
        // The operator agent runs on THIS workstation. `master.tsx`'s first-run effect already
        // returns early in a remote window for the same reason.
        expect(dropUndeliverable([feature('genie-os')], remote)).toEqual([]);
    });

    it('keeps everything else, which is most of them', () => {
        const ids = ['lists', 'questions', 'flows', 'issuewatch', 'docs', 'tasks', 'knowledge-graph'];
        expect(dropUndeliverable(ids.map(feature), remote).map((i) => i.featureId)).toEqual(ids);
    });

    it('keeps ALL of them in a local window', () => {
        const ids = ['sharing', 'remote-host', 'genie-os', 'lists'];
        expect(dropUndeliverable(ids.map(feature), local).map((i) => i.featureId)).toEqual(ids);
    });

    it('does not touch non-feature rows', () => {
        // A workspace row has no `featureId`. Dropping one because a remote window is open would
        // remove the thing a person most wants there.
        const workspace: CommandItem = { id: 'ws:1', category: 'workspace', label: 'tynn' };
        expect(dropUndeliverable([workspace], remote)).toEqual([workspace]);
    });
});

describe('TYNN IS OPTIONAL — its features say so rather than disappearing', () => {
    /**
     * Owner decision, asked directly, 2026-10-08: *"fully local mode — everything local works, Tynn
     * features say 'sign in to use this'."*
     *
     * Until now Tynn was a hard gate on the whole app: `master.tsx` returned a sign-in prompt
     * instead of rendering, so a workstation with no account could not open a workspace, run an
     * agent or see the Deck — none of which needs one.
     *
     * ## Why these rows are KEPT rather than dropped
     *
     * `LOCAL_ONLY_FEATURES` drops Sharing, Hosts and Genie OS in a REMOTE window, because there the
     * feature belongs to a different machine and there is nothing a person can do about it from
     * here. Signing in IS something a person can do — so a Tynn-backed row stays, says what it
     * needs, and activating it starts the sign-in rather than opening a surface that cannot work.
     *
     * A dropped row teaches that the feature does not exist. That is the one wrong lesson here.
     */
    const feature = (id: string): CommandItem => ({
        id: `feature:${id}`,
        category: 'panel',
        label: id,
        featureId: id,
    });

    const signedOut = { hasTerminal: true, tynn: false };
    const signedIn = { hasTerminal: true, tynn: true };

    it('keeps every Tynn-backed row when signed out', () => {
        const ids = ['sites', 'remote-host', 'issuewatch', 'sharing'];
        expect(dropUndeliverable(ids.map(feature), signedOut).map((i) => i.featureId)).toEqual(ids);
    });

    it('says SIGN IN on each of them, so the row explains itself', () => {
        for (const id of ['sites', 'remote-host', 'issuewatch', 'sharing']) {
            const [row] = dropUndeliverable([feature(id)], signedOut);
            expect(row!.hint, `${id} should say it needs an account`).toMatch(/sign in/i);
        }
    });

    it('leaves purely LOCAL features alone', () => {
        // The whole point of fully-local mode: these work with no account and must not be marked.
        for (const id of ['lists', 'questions', 'flows', 'docs', 'tasks', 'grid', 'genie-os']) {
            const [row] = dropUndeliverable([feature(id)], signedOut);
            expect(row!.hint ?? '').not.toMatch(/sign in/i);
        }
    });

    it('says nothing about sign-in once there IS an account', () => {
        for (const id of ['sites', 'remote-host', 'issuewatch', 'sharing']) {
            const [row] = dropUndeliverable([feature(id)], signedIn);
            expect(row!.hint ?? '').not.toMatch(/sign in/i);
        }
    });

    it('does not overwrite a hint the feature already had', () => {
        // `FEATURE_SURFACES` gives some rows a contextual hint. Replacing it would lose a real
        // route in order to say something the state already shows.
        const withHint: CommandItem = { ...feature('sharing'), hint: 'Settings → hosts' };
        const [row] = dropUndeliverable([withHint], signedOut);
        expect(row!.hint).toContain('Settings → hosts');
        expect(row!.hint).toMatch(/sign in/i);
    });

    it('treats an UNKNOWN tynn state as signed in, so nothing is marked on a guess', () => {
        // `tynn` is omitted by callers that do not know — a remote window, a test. Marking a row
        // "sign in" when we cannot tell would be an accusation about an account we never checked.
        const [row] = dropUndeliverable([feature('sharing')], { hasTerminal: true });
        expect(row!.hint ?? '').not.toMatch(/sign in/i);
    });
});
