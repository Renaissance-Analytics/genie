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
