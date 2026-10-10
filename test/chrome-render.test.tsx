import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { FEATURE_ICONS } from '../src/core/rail-view.js';

/**
 * THE CHROME — the title bar and the rail.
 *
 * ## The one assertion this whole file exists for
 *
 * **Navigation is persistent, labelled, and reachable without a keyboard shortcut.** The
 * previous attempt deleted the rail and called ⌘K its replacement, and the acceptance bar the
 * owner set is a person with no instructions reaching the Dashboard inside thirty seconds.
 * A palette cannot do that: it helps you find a surface you already know exists.
 *
 * So the tests below insist on *labelled, clickable* rows carrying the words a newcomer would
 * look for, and they insist the palette is not the only route — asserted as a contrast, since
 * "a Dashboard row exists" is worth nothing if a Dashboard row is the only thing that exists.
 *
 * As in the Dashboard's render tests: this is a claim about MARKUP. It does not prove the bar
 * is 36px on screen, that the gradient renders, or that a click navigates.
 */

const WORKSPACES = [
    { id: 'tynn', path: 'C:/_Projects/tynn.ai', count: 4, alert: true },
    { id: 'fancy', path: 'C:/_Projects/fancy', count: 6, alert: false },
    { id: 'cold', path: 'C:/_Projects/cold', count: null, alert: null },
];

const bar = (over: Partial<Parameters<typeof TitleBar>[0]> = {}): string =>
    renderToStaticMarkup(
        <TitleBar
            route="genie://dashboard?group=workspace"
            workstation={{ name: 'alphar', healthy: true }}
            onNavigate={() => {}}
            onOpenPalette={() => {}}
            {...over}
        />,
    );

const rail = (over: Partial<Parameters<typeof Sidebar>[0]> = {}): string =>
    renderToStaticMarkup(
        <Sidebar
            route="genie://dashboard?group=workspace"
            deckCount={2}
            workspaces={WORKSPACES}
            available={['deck', 'dashboard', 'genie', 'workspace']}
            onNavigate={() => {}}
            {...over}
        />,
    );

describe('the title bar', () => {
    it('is 36px, and leads with the mark and the name', () => {
        const html = bar();
        expect(html).toContain('h-9');                       // 36px
        expect(html).toContain('data-brand-mark');
        expect(html).toContain('Genie');
    });

    it('carries the four feature icons, every one with an accessible name', () => {
        /**
         * The owner's decision, absent from the board because the board predates it.
         *
         * The load-bearing claim is the NAME, not the glyph: four unexplained marks in the
         * chrome is how a finished feature ships and nobody finds it. The tooltip's text
         * cannot be asserted from static markup — Fancy's `Tooltip` renders its content on
         * hover — so the accessible name is asserted instead, and the component feeds both
         * from the same string.
         */
        const html = bar();
        const labelled = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);

        for (const f of FEATURE_ICONS) expect(labelled).toContain(f.label);
        expect(FEATURE_ICONS.map((f) => f.label)).toEqual(['GApps', 'Knowledge Graph', 'Flows', 'Genie OSA']);

        // COUNT: four feature buttons, none of them unlabelled.
        expect([...html.matchAll(/data-feature="/g)]).toHaveLength(4);
        expect([...html.matchAll(/data-feature="[^"]*"(?![^>]*aria-label=)/g)]).toEqual([]);
    });

    it('shows the current route, because that is how a human and an agent name the same place', () => {
        // Load-bearing, not decoration: an agent hands over `genie://agent/kai?tab=stream&at=…`
        // and the human has to be able to see where they are to know they arrived.
        expect(bar({ route: 'genie://agent/kai?tab=stream' })).toContain('genie://agent/kai?tab=stream');
    });

    it('offers the palette as a 280\u00d724 box with its own placeholder, NOT as the only route', () => {
        const html = bar();
        expect(html).toContain('w-[280px]');
        expect(html).toContain('Search, jump, run');
        // The hint names a key this reader actually HAS, so it is platform-dependent and
        // asserted by platform in its own describe below.
        expect(html).toContain('data-palette-hint');

        // The contrast that makes the previous assertion mean something: the bar also carries
        // a labelled route home. A palette-only chrome would pass everything above.
        expect(html).toMatch(/data-nav="genie:\/\/dashboard"/);
    });

    it('names the workstation, and says healthy with a dot rather than with a word', () => {
        const healthy = bar({ workstation: { name: 'alphar', healthy: true } });
        expect(healthy).toContain('alphar');
        expect(healthy).toContain('data-workstation-health="healthy"');

        // POSITIVE CONTROL: the chip distinguishes the two states, so "healthy" is a reading
        // rather than a constant.
        expect(bar({ workstation: { name: 'alphar', healthy: false } }))
            .toContain('data-workstation-health="unhealthy"');
    });
});

    it('renders NO workstation chip until the workstation is known', () => {
        /**
         * `healthy: false` on first paint is a red dot asserting the machine is unwell, which
         * is a claim about a thing nobody has checked yet. An earlier draft of the snapshot
         * type made the chip non-nullable with exactly that default, and it would have shipped
         * a boot-time fault light.
         *
         * So the chip is absent until there is something to say — and absent means no dot and
         * no name, not a grey dot, because a grey dot still asserts a reading.
         */
        const html = bar({ workstation: null });

        expect(html).not.toContain('data-workstation-health');
        expect(html).not.toContain('alphar');

        // POSITIVE CONTROL: the chip exists and both states render, in the same component.
        expect(bar({ workstation: { name: 'alphar', healthy: true } }))
            .toContain('data-workstation-health="healthy"');
        expect(bar({ workstation: { name: 'alphar', healthy: false } }))
            .toContain('data-workstation-health="unhealthy"');
    });

describe('the palette hint', () => {
    it('says Ctrl on a generic platform and ⌘ on an Apple one', () => {
        /**
         * Found by looking at a screenshot of the running app, where `⌘` was a tofu box in
         * a font with no glyph for it. The missing glyph made it visible; the wrongness was
         * there on every non-Apple platform, where that key does not exist.
         *
         * The resolution now comes from the kit (`detectPlatform` / `modifierKeyLabel`), which
         * takes the platform as an argument for exactly the reason argued here: both branches
         * have to be renderable on one machine, or the Windows one is never exercised by the
         * Linux runner that gates merges.
         */
        expect(bar({ platform: 'generic' })).toContain('Ctrl K');
        expect(bar({ platform: 'generic' })).not.toContain('⌘');

        // POSITIVE CONTROL: the Apple branch still renders the symbol, so the absence above is
        // a reading rather than a component that simply stopped printing it.
        expect(bar({ platform: 'apple' })).toContain('⌘K');
    });

    it('falls back to the PRESSABLE label when the platform is unresolved', () => {
        /**
         * `generic` is the fallback and that is load-bearing, not a default. Submit accepts
         * `metaKey || ctrlKey`, so `Ctrl` is a TRUE label on an Apple keyboard while `⌘` is
         * false everywhere else. An unresolved platform gets the label that is pressable on all
         * of them, not the prettier one.
         *
         * Server-rendered here, where there is no `navigator` at all — which is the unresolved
         * case, and the first paint every user sees.
         */
        expect(bar()).toContain('Ctrl K');
        expect(bar()).not.toContain('⌘');
    });
});

describe('the rail', () => {
    it('is 208px wide and carries Deck, Dashboard and genie as labelled rows', () => {
        const html = rail();
        expect(html).toContain('w-52');  // 208px

        for (const label of ['Deck', 'Dashboard', 'genie']) expect(html).toContain(label);
        // Every one is a real control a person can click, not a decorated div.
        expect([...html.matchAll(/data-nav="/g)].length).toBeGreaterThanOrEqual(3);
    });

    it('marks the active row from the ROUTE, so refresh and a deep link agree with it', () => {
        const onDeck = rail({ route: 'genie://deck' });
        expect(onDeck).toMatch(/data-nav="genie:\/\/deck"[^>]*data-active="true"/);
        expect(onDeck).not.toMatch(/data-nav="genie:\/\/dashboard"[^>]*data-active="true"/);

        // POSITIVE CONTROL: the other way round, from the other route.
        const onDash = rail({ route: 'genie://dashboard?group=workspace' });
        expect(onDash).toMatch(/data-nav="genie:\/\/dashboard"[^>]*data-active="true"/);
    });

    it('badges the Deck with a count, and shows NO badge at zero', () => {
        expect(rail({ deckCount: 2 })).toContain('data-deck-badge="2"');

        // The Deck is the only place a badge exists, and a badge that is sometimes 0 is
        // furniture. Both nothings: a measured empty queue and an unread one.
        expect(rail({ deckCount: 0 })).not.toContain('data-deck-badge');
        expect(rail({ deckCount: null })).not.toContain('data-deck-badge');
    });

    it('shows a count and an alert dot per workspace', () => {
        const html = rail();
        expect(html).toMatch(/data-workspace="tynn"[\s\S]*?data-alert="true"/);
        expect(html).toContain('>4</span>');
        expect(html).toContain('>6</span>');
    });

    it('renders NEITHER a count NOR a dot for a workspace that has not been read', () => {
        // First paint is skeletons, never zeros: a `0` here means "we have not looked" wearing
        // "it is empty"'s clothes.
        const html = rail();
        const cold = html.slice(html.indexOf('data-workspace="cold"'));

        expect(cold).not.toContain('data-alert');
        expect(cold).not.toMatch(/>0</);

        // POSITIVE CONTROL, in the same render: the workspaces that WERE read show both.
        expect(html).toMatch(/data-workspace="fancy"[\s\S]*?data-alert="false"/);
    });

    it('renders a measured zero for a workspace read and found empty', () => {
        const html = rail({
            workspaces: [{ id: 'empty', path: 'C:/x', count: 0, alert: false }],
        });
        expect(html).toMatch(/>0</);
        expect(html).toContain('data-alert="false"');
    });

    it('OMITS a surface that cannot render yet — absence, never a disabled row', () => {
        /**
         * *"A disabled control is an accusation; a different shape is a fact."* The house rule
         * is stated about tabs and it holds here: a Deck row that greys out when clicked
         * blames the user for the build's progress.
         *
         * This is also the honest half of the phase plan. Each phase ends with the app
         * USABLE, and a rail that offers a route the shell cannot serve is not usable — it is
         * the previous attempt's "built and unreachable" with the arrow pointing the other
         * way. The row comes back when its surface does, and nothing else changes.
         */
        const html = rail({ available: ['dashboard', 'workspace'] });

        expect(html).not.toContain('data-nav="genie://deck"');
        expect(html).not.toContain('data-nav="genie://agent/genie"');
        expect(html).not.toContain('disabled');
        // No orphan badge either: the Deck's count has nowhere to live without the Deck.
        expect(html).not.toContain('data-deck-badge');

        // POSITIVE CONTROL: the rail is not simply empty, and the workspaces still render.
        expect(html).toContain('data-nav="genie://dashboard"');
        expect(html).toContain('data-workspace="tynn"');
    });

    it('omits the WORKSPACES section whole, header included, when that surface is unbuilt', () => {
        // An orphan section heading over nothing is worse than no heading: it reads as a list
        // that failed to load. If the rows cannot be served, the group does not exist.
        const html = rail({ available: ['dashboard'] });

        expect(html).not.toContain('data-workspace=');
        expect(html).not.toContain('Workspaces');

        // POSITIVE CONTROL: with the surface available, both the header and the rows are there.
        const full = rail({ available: ['dashboard', 'workspace'] });
        expect(full).toContain('Workspaces');
        expect(full).toContain('data-workspace="tynn"');
    });

    it('keeps the given order rather than sorting the rail under the cursor', () => {
        const html = rail();
        const order = [...html.matchAll(/data-workspace="([^"]+)"/g)].map((m) => m[1]);
        expect(order).toEqual(['tynn', 'fancy', 'cold']);
    });
});
