import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY CLASS A GENIE 2 SURFACE RENDERS HAS A RULE SOMEWHERE.
 *
 * ## The defect this exists for, which shipped and was found by hand
 *
 * The Agent view — the most important screen in Genie 2, the one the Deck navigates to — had
 * **no CSS at all**. `.agent-view`, `.agent-view-head`, `.agent-view-tabs`, `.agent-view-body`,
 * `.agent-view-rail`, `.agent-conversation`, `.agent-msg`, `.agent-tool`, `.agent-approval` and
 * `.agent-composer` each appeared in exactly one place in the repository: the component. The
 * Deck was fully styled, so the problem was invisible from every direction that was being
 * checked.
 *
 * Nothing could have caught it. A typecheck sees a string. A render test asserts markup, and the
 * markup was right — unstyled divs render perfectly. The only observation that distinguishes a
 * styled surface from a bare stack of divs is LOOKING at it, and looking is exactly what cannot
 * happen here: agents do not open the app on the owner's desktop.
 *
 * So this is the substitute, and it is a source-level test on purpose: it asks whether each
 * class the component writes has a rule to match, which is cheap, deterministic, and runs for
 * everyone. It cannot judge whether the result looks GOOD — no test can — but "a surface with no
 * styles at all" is the failure that actually happened, and this makes it impossible to repeat.
 *
 * ## What it deliberately does not do
 *
 * It does not demand a rule for every class in the renderer. Fancy components bring their own,
 * utility classes are Tailwind's, and a `data-` attribute selector is a different question. It
 * covers the classes GENIE invents for its own Genie 2 surfaces, which is where the gap was.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');

const CSS = [read('renderer/styles/master.css'), read('renderer/styles/globals.css')].join('\n');

/**
 * Every `className="…"` literal in a component, split into class names.
 *
 * Template literals and conditionals are read as text and then split, so a
 * `className={on ? 'agent-tab on' : 'agent-tab'}` contributes both — which is the behaviour we
 * want, since both forms reach the DOM.
 */
function classesIn(rel: string): string[] {
    const src = read(rel);
    const found = new Set<string>();
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{[^}]*?'([^']*)'[^}]*?\})/g)) {
        const text = m[1] ?? m[2] ?? m[3] ?? '';
        for (const raw of text.split(/\s+/)) {
            const name = raw.trim();
            // Interpolations (`plan-${p.status}`) and empties are not class names we can check.
            if (!name || name.includes('$') || name.includes('{')) continue;
            found.add(name);
        }
    }
    return [...found];
}

/** Does the sheet carry a rule for this class? */
const styled = (name: string) => new RegExp(`\\.${name}(?![\\w-])`).test(CSS);

const SURFACES = [
    'renderer/components/Master/AgentView.tsx',
    'renderer/components/Master/Deck.tsx',
    'renderer/components/Master/NeedsYou.tsx',
];

describe('Genie 2 surfaces are actually styled', () => {
    it('POSITIVE CONTROL: the scan finds real class names', () => {
        // Without this the whole file passes vacuously the moment the regex stops matching —
        // which is the classic way a source-level test rots into decoration.
        const names = classesIn('renderer/components/Master/AgentView.tsx');
        expect(names).toContain('agent-view');
        expect(names).toContain('agent-composer');
        expect(names.length).toBeGreaterThan(8);
    });

    it('POSITIVE CONTROL: the sheet check can say NO', () => {
        // The other half: a lookup that always answered true would hide every real failure.
        expect(styled('agent-view')).toBe(true);
        expect(styled('a-class-nobody-has-ever-written')).toBe(false);
    });

    for (const rel of SURFACES) {
        it(`every class ${rel.split('/').pop()} renders has a rule`, () => {
            const missing = classesIn(rel).filter((name) => !styled(name));
            expect(missing).toEqual([]);
        });
    }
});
