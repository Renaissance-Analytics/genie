import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Icon } from '@particle-academy/react-fancy';
// `resolveIcon` comes from the SUBPATH deliberately. react-fancy 5.34.0's root `index.d.ts`
// declares it as a root export and the root `index.js` does not actually export it, so
// importing it from the root typechecks clean and throws "resolveIcon is not a function" at
// runtime. Reported to the kit; the subpath is correct either way.
import { resolveIcon } from '@particle-academy/react-fancy/icon';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, registerAppIcons } from '../src/renderer/icons.js';
import { ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';

/**
 * ICONS MUST ACTUALLY RESOLVE.
 *
 * Fancy's `Icon` renders an **empty span** for a name that is not registered. No warning, no
 * fallback glyph, no thrown error. The markup stays structurally correct, so every surface
 * test keeps passing while the app shows blank gaps where its icons should be.
 *
 * This was found by reading a render dump, not by a test — four feature buttons with the right
 * labels, the right classes, and nothing inside them, on a green suite. A whole class of
 * "shipped and visibly broken" lives in that gap, so it gets a test of its own.
 */

describe('every icon the app asks for', () => {
    it('resolves to a real component once registered', () => {
        registerAppIcons();

        const missing = ICON_NAMES.filter((name) => resolveIcon(name) === null);
        expect(missing).toEqual([]);

        // POSITIVE CONTROL: `resolveIcon` can say no, so an empty `missing` is a reading rather
        // than a function that always returns something. Without this the test passes equally
        // well against a `resolveIcon` that never fails.
        expect(resolveIcon('definitely-not-an-icon-name')).toBeNull();
    });

    it('renders actual SVG content, not an empty span', () => {
        /**
         * The assertion that matches the real failure. `resolveIcon` returning a component is
         * one step removed from what a person sees; this renders the component the application
         * renders and insists something came out of it.
         */
        registerAppIcons();

        for (const name of ICON_NAMES) {
            const html = renderToStaticMarkup(createElement(Icon, { name }));
            expect(html, `icon "${name}" rendered nothing`).toContain('<svg');
        }
    });

    it('lists every name the surfaces pass to Icon', () => {
        /**
         * The list and the components have to agree, and nothing in the type system makes
         * them. So this reads the component sources and compares.
         *
         * Without it `ICON_NAMES` is a list that only has to agree with itself: someone adds
         * `<Icon name="pencil">` to a new row, never touches this file, and the icon is blank
         * in the shipped app while all three tests above stay green.
         */
        const sources = import.meta.glob('../src/renderer/**/*.tsx', { query: '?raw', import: 'default', eager: true });

        const used = new Set<string>();
        for (const source of Object.values(sources) as string[]) {
            for (const m of source.matchAll(/<Icon\s+name=\{?"([a-z0-9-]+)"/g)) used.add(m[1] as string);
        }

        // POSITIVE CONTROL: the scan found names at all. An empty set would make the next
        // assertion vacuous, and a changed JSX style is exactly how that would happen quietly.
        expect(used.size).toBeGreaterThan(3);

        expect([...used].filter((name) => !ICON_NAMES.includes(name))).toEqual([]);
    });
});

describe('the icons the ledger chooses at RUNTIME', () => {
    it('are all registered — driven by the real function, not by reading the source', () => {
        /**
         * `StreamRow` passes `name={row.icon}`, so the source scan above cannot see a single
         * one of these. An unregistered name renders an empty span with no warning, which means
         * the entire Stream could ship with blank glyphs on a green suite — which is how the
         * blank chrome icons got here in the first place.
         *
         * So this drives `ledgerRow` over every event kind AND every tool kind, collects the
         * icons it actually emits, and insists each one resolves. A guard that does not care
         * how the JSX is written.
         */
        registerAppIcons();

        const tool = (toolKind: string | null): StreamEvent => ({
            kind: 'tool', toolCallId: 't', name: 'X', title: 'x', status: 'completed',
            toolKind: toolKind as never, rawInput: {},
        });

        const events: StreamEvent[] = [
            { kind: 'message', speaker: 'you', peerName: null, text: 'x' },
            { kind: 'think', text: 'x', tokens: null },
            { kind: 'usage', used: 1, size: 2, cost: null },
            { kind: 'plan', entries: [] },
            { kind: 'divider', variant: 'compaction', before: null, after: null },
            { kind: 'notice', level: 'warn', message: 'x' },
            { kind: 'unknown', sessionUpdate: 'future_thing', raw: {} },
            ...(['allowed', 'denied', 'answered', 'cancelled'] as const).map((outcome): StreamEvent => ({ kind: 'approval', question: 'x', tool: 'Bash', outcome, optionId: null })),
            ...['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other', null].map(tool),
        ];

        const rows: TimedEvent[] = events.map((event, i) => ({ id: `e${i}`, event, at: null }));
        const icons = [...new Set(rows.map((r) => ledgerRow(r).icon))];

        // POSITIVE CONTROL first: the sweep produced a real spread of icons, so an empty
        // `missing` below means something. Fifteen events cannot yield one icon.
        expect(icons.length).toBeGreaterThan(6);

        expect(icons.filter((name) => !ICON_NAMES.includes(name))).toEqual([]);
        expect(icons.filter((name) => resolveIcon(name) === null)).toEqual([]);
    });
});

describe('icons named in DATA, not JSX', () => {
    // The Settings sidebar's icons come from core/settings-nav.ts, which no JSX literal scan sees (2026-10-19: ten of
    // thirteen were unregistered and would have drawn as empty spans on a green suite).
    it('every Settings sidebar icon is registered and resolves', async () => {
        const { NAV_GROUPS } = await import('../src/core/settings-nav.js');
        registerAppIcons();
        const names = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.icon));
        expect(names.filter((n) => !ICON_NAMES.includes(n))).toEqual([]);
        expect(names.filter((n) => !resolveIcon(n))).toEqual([]);
    });
});
