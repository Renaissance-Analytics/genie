import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_SURFACES } from '../feature-reachability';
import { codeOnly } from '../../../main/__tests__/support/code-only';

/**
 * EVERY REGISTERED FEATURE MUST HAVE A ROUTER CASE — the other half of reachability.
 *
 * `feature-reachability.test.ts` proves each feature has an ENTRY POINT: a palette row exists
 * because `featureCommandItems(FEATURE_SURFACES)` generates one for every registry entry. What
 * nothing checked is whether that row DOES anything.
 *
 * `activateFeature` in `master.tsx` is a `switch` over feature ids. A feature registered
 * without a `case` gets a palette row that looks live and silently does nothing — and
 * `command-window.ts` names that cost in its own words, about a different kind of row: *"A
 * dead row is worse than an absent one."* It is also precisely the shape of the defect that
 * cost this project a day (`acp_engine`: a settings row, a UI switch, two release notes, and
 * no reader anywhere), so the two halves of reachability are now both guarded.
 *
 * This is a SOURCE guard because `activateFeature` lives inside a 5,000-line component whose
 * handler logic is not independently importable. Comments are stripped (`codeOnly`, CRLF-safe)
 * so the prose above — which contains the word `case` — cannot satisfy it.
 */

const MASTER = codeOnly(readFileSync(join(__dirname, '../../pages/master.tsx'), 'utf8'));

describe('the feature router', () => {
    it('reads a real switch, so the assertions below are not vacuous', () => {
        // Without this, a renamed function or a moved switch would make every id "missing" —
        // or, worse, a bad slice would make them all pass.
        expect(MASTER).toMatch(/activateFeature/);
        expect(FEATURE_SURFACES.length).toBeGreaterThan(10);
    });

    it('handles every feature the registry declares', () => {
        /**
         * The registry is what the palette offers, in full: `featureCommandItems` maps ALL of
         * `FEATURE_SURFACES`, including the ones whose documented entry point is a menu item
         * rather than a palette row. So every id here is dispatchable, and every id must be
         * dispatched.
         */
        const missing = FEATURE_SURFACES.map((f) => f.id).filter(
            (id) => !new RegExp(`case '${id}':`).test(MASTER),
        );
        expect(
            missing,
            `these features are registered and offered in the palette but have no case in activateFeature, so their rows would do nothing: ${missing.join(', ')}`,
        ).toEqual([]);
    });
});


/**
 * AND EVERY SHORTCUT INTENT MUST BE ACTED ON — the same defect, one layer over.
 *
 * `resolveShortcut` answers what the human asked for; `master.tsx` performs it. An intent the
 * resolver can return and the component never handles is a DEAD KEY: the chord is captured
 * (and `preventDefault`ed away from the browser's own meaning) and nothing happens.
 *
 * That is worse than an unbound key, because the native behaviour is taken too. ⌘J is the
 * reason this exists: it was assigned in the resolver and the handler came several minutes
 * later, and in between nothing would have told anyone.
 *
 * The intents are read out of the TYPE rather than listed here — a list typed here would pass
 * by construction, which is the mistake `update-to-session.test.ts` refuses by name.
 */
describe('the shortcut dispatch', () => {
    const SHORTCUTS = codeOnly(
        readFileSync(join(__dirname, '../master-shortcuts.ts'), 'utf8'),
    );

    it('reads both files, so the comparison is not against nothing', () => {
        expect(SHORTCUTS).toMatch(/export type ShortcutIntent/);
        expect(MASTER).toMatch(/intent\.kind ===/);
    });

    it('handles every intent the resolver can return', () => {
        // Every `{ kind: 'x' }` member of the union, taken from the type's own declaration.
        const union = SHORTCUTS.slice(
            SHORTCUTS.indexOf('export type ShortcutIntent'),
            SHORTCUTS.indexOf(';', SHORTCUTS.indexOf('export type ShortcutIntent')),
        );
        const kinds = [...new Set([...union.matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]!))];
        expect(kinds.length).toBeGreaterThan(5);

        const unhandled = kinds.filter((k) => !MASTER.includes(`intent.kind === '${k}'`));
        expect(
            unhandled,
            `these shortcut intents are resolvable but never acted on, so the chord is swallowed and nothing happens: ${unhandled.join(', ')}`,
        ).toEqual([]);
    });
});
