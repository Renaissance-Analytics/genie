import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * THE AGENT MANAGER IS ACTUALLY ON SCREEN WHEN IT OPENS.
 *
 * The owner, for the third time and with a screenshot of the menu: *"the fucking
 * Edit agent button in the agent menu still won't open the edit agent ux."*
 *
 * It opened every time. `Edit agent…` set `manageAgentId`, React rendered the
 * manager — inside `<div className="modal-backdrop">` and `<div className="modal
 * agent-manager-modal">`, and NOT ONE of those classes had a rule in any
 * stylesheet. An unstyled backdrop is not an overlay: no `position: fixed`, no
 * `z-index`, no centring. It laid out inline at the end of the document, below
 * everything, and the person saw nothing happen.
 *
 * That is why the previous fix did not help. That one corrected the ROUTE — a
 * dormant agent has no terminal spec, so the item used to be guarded behind one
 * and silently did nothing. The route has been right ever since; the destination
 * was never visible.
 *
 * ## Why this is a stylesheet test
 *
 * The component is covered. The wiring is covered. What nothing covered is the
 * join between the JSX and the CSS, which is exactly where this lived: every
 * class name was spelled consistently and referred to nothing. So this reads the
 * real `master.tsx`, takes the class names the modal actually uses, and requires
 * each to exist — which catches the whole family, not only the four that were
 * missing this time.
 */
const RENDERER = path.resolve(__dirname, '../..');
const MASTER_TSX = fs.readFileSync(path.join(RENDERER, 'pages', 'master.tsx'), 'utf8');
const CSS = ['globals.css', 'master.css']
    .map((f) => fs.readFileSync(path.join(RENDERER, 'styles', f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** The JSX block the agent manager renders in, sliced from the real source. */
function agentManagerBlock(): string {
    const start = MASTER_TSX.indexOf('{manageAgentId && (');
    expect(start, 'the agent manager block moved — this test is pinning nothing').toBeGreaterThan(
        -1,
    );
    // Far enough to cover the wrapper and its chrome; the manager's own
    // internals are styled in their own components and not this test's subject.
    return MASTER_TSX.slice(start, start + 1400);
}

/** Every class name used in that block, flattened from its className literals. */
function classesUsed(block: string): string[] {
    const out = new Set<string>();
    for (const m of block.matchAll(/className="([^"{}]+)"/g)) {
        for (const c of m[1]!.split(/\s+/)) if (c) out.add(c);
    }
    return [...out];
}

/** Does any rule in the stylesheets target this class? */
function styled(cls: string): boolean {
    return new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}(?![\\w-])`).test(CSS);
}

/** The value of `prop` on the first rule whose selector list contains `selector`. */
function decl(selector: string, prop: string): string | null {
    const re = new RegExp(
        `(?:^|[},])\\s*${selector.replace(/[.\-]/g, '\\$&')}\\s*\\{([^{}]*)\\}`,
        'm',
    );
    const body = re.exec(CSS)?.[1];
    if (!body) return null;
    const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'm').exec(body);
    return d ? d[1]!.trim() : null;
}

describe('every class the agent-manager modal uses is a class that exists', () => {
    it('names no class the stylesheets have never heard of', () => {
        // The bug, stated exactly: `modal-backdrop`, `modal`, `modal-head` and
        // `modal-title` were all invented at the point of use. A class name that
        // matches nothing fails silently and forever — the element renders, it
        // simply has no appearance and no position.
        const missing = classesUsed(agentManagerBlock()).filter((c) => !styled(c));

        expect(missing, `the agent manager uses undefined classes: ${missing.join(', ')}`).toEqual(
            [],
        );
    });

    it('CONTROL: the detector really can tell a missing class from a present one', () => {
        // Without this, "nothing is missing" would pass just as well against a
        // `styled()` that returned true for everything.
        expect(styled('prompt-scrim')).toBe(true);
        expect(styled('a-class-nobody-ever-wrote')).toBe(false);
    });
});

describe('the overlay it opens in is really an overlay', () => {
    /** The backdrop class the modal actually uses, whatever it is called today. */
    const backdrop = (): string => {
        const first = classesUsed(agentManagerBlock())[0];
        expect(first, 'the block has no className at all').toBeTruthy();
        return first!;
    };

    it('is taken out of the document flow and put above the app', () => {
        // The two properties that decide whether a person sees it. An unstyled
        // div satisfies neither, which is the whole of this bug: it rendered at
        // the end of the page, under everything, at zero z-index.
        expect(decl(`.${backdrop()}`, 'position')).toBe('fixed');
        expect(Number(decl(`.${backdrop()}`, 'z-index'))).toBeGreaterThan(0);
    });

    it('CONTROL: the app has a working overlay, and it looks like this', () => {
        // `.prompt-scrim` backs every modal that has always worked. If it ever
        // stops declaring these, this file is pinning a shape that no longer
        // means anything and should say so here rather than passing quietly.
        expect(decl('.prompt-scrim', 'position')).toBe('fixed');
        expect(Number(decl('.prompt-scrim', 'z-index'))).toBeGreaterThan(0);
    });
});
