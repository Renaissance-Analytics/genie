import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The ForceTheQuestion modal's chrome (Tynn story #272).
 *
 * Three of the four complaints in that story are stylesheet facts, and each one
 * had been on screen long enough that nobody could say when it started:
 *
 *  1. **Two nested scrollbars.** `.ask-body` scrolled, and `.ask-q-content`
 *     scrolled INSIDE it under a `max-height: 40vh`. Two scroll thumbs inside a
 *     560px window, and a reader who scrolled the wrong one lost their place.
 *     The question body must GROW; `.ask-body` is the one region that scrolls.
 *  2. **A card inside a card.** `.ask-frame` fills the whole frameless window
 *     (`height: 100vh`) and drew its own border + 20px radius + drop shadow on
 *     top of it — a bordered box wrapping the modal's content with nothing
 *     around it but the window it already fills.
 *  3. **Seams that are not flush.** That radius is what made them visible: a
 *     rounded frame inside a square window leaves the window's own background
 *     showing through at all four corners.
 *
 * These are asserted against the STYLESHEET rather than a render because the
 * renderer has no jsdom harness (see vitest.config.ts). The layout claim the
 * stylesheet cannot make — that a LONG question grows instead of scrolling and a
 * SHORT one still renders — is proved against the real window in
 * `e2e/ask-modal.spec.ts`, at two sizes, because "it grows" passes just as well
 * against a layout that only ever renders one size.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '../../styles/globals.css'), 'utf8');

interface Rule {
    selectors: string[];
    body: string;
}

/** Every top-level rule in the stylesheet, comments stripped. */
function rules(): Rule[] {
    const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Rule[] = [];
    const re = /^([^@\s}][^{}]*)\{([^{}]*)\}/gm;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        out.push({
            selectors: m[1]!.split(',').map((s) => s.trim()),
            body: m[2]!,
        });
    }
    return out;
}

/** The body of the first rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
    const hit = rules().find((r) => r.selectors.includes(selector));
    if (!hit) throw new Error(`no rule for ${selector}`);
    return hit.body;
}

/** The value of `prop` in `selector`'s rule, or null when it declares none. */
function decl(selector: string, prop: string): string | null {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'm').exec(ruleBody(selector));
    return m ? m[1]!.trim() : null;
}

/** True when a declaration body asks for a scrollbar on either axis. */
function scrolls(body: string): boolean {
    return /(?:^|;)\s*overflow(?:-x|-y)?\s*:\s*(auto|scroll)/m.test(body);
}

describe('the question body grows — one scroll region, not two', () => {
    it('.ask-q-content is not capped, so a long question grows', () => {
        expect(decl('.ask-q-content', 'max-height')).toBeNull();
    });

    it('.ask-q-content does not scroll inside the body that already scrolls', () => {
        expect(scrolls(ruleBody('.ask-q-content'))).toBe(false);
    });

    it('exactly one rule in the modal column scrolls, and it is .ask-body', () => {
        // The file drawer (`.ask-file-*`) is a SEPARATE pane beside the modal,
        // not a region nested inside it, so it is not part of this count.
        const column = rules().filter((r) =>
            r.selectors.some((s) => /(^|\s)\.ask-/.test(s) && !/\.ask-file-/.test(s)),
        );
        const scrolling = column
            .filter((r) => scrolls(r.body))
            .flatMap((r) => r.selectors);
        expect(scrolling).toEqual(['.ask-body']);
    });
});

describe('no card inside the card, and the seams are flush', () => {
    it('.ask-frame fills the window rather than sitting in it', () => {
        expect(decl('.ask-frame', 'height')).toBe('100vh');
    });

    it('.ask-frame draws no border of its own', () => {
        expect(decl('.ask-frame', 'border')).toBeNull();
    });

    it('.ask-frame has no rounded corners to meet the square window edge', () => {
        expect(decl('.ask-frame', 'border-radius')).toBeNull();
    });

    it('.ask-frame casts no shadow — there is nothing behind it to cast onto', () => {
        expect(decl('.ask-frame', 'box-shadow')).toBeNull();
    });
});
