import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PromptFocusOptions, PromptSetDraftOptions } from '@particle-academy/react-fancy';
import type { ChatDraft } from '../src/core/chat-drafts.js';
import { applyChatInsert, planStepInsert, type DraftHandle } from '../src/core/plan-pill.js';

/**
 * THE PLAN PILL FOCUSES THE COMPOSER WITHOUT SCROLLING ANYTHING (genie#1290 follow-up, react-fancy 5.69.0).
 *
 * #1282's plan-step pill is put into the chat with `setDraft(draft, { focus: true })`. Up to 5.68 react-fancy's
 * PromptInput then called its element's bare `focus()`, and a bare focus scrolls every scrollable ancestor to reveal the
 * element, up to the document. #1291 locked Genie's root so that cannot scroll the WINDOW; 5.69.0 stops the scroll at its
 * source: `focus()` and `setDraft(…, { focus: true })` default to `{ preventScroll: true }`, with a per-call opt-out.
 *
 * Genie RELIES on that default: it passes `{ focus }` and nothing else, so it must never opt out, and the react-fancy it
 * runs must be one that defaults to no scroll. #1291's own guards (the root lock, the `relative` chat scroller,
 * `preventScroll` on Genie's own `.focus()` calls) stay as defence in depth.
 *
 * What this file CANNOT prove (docs/decisions.md D3: no DOM here): that a real browser does not scroll. That is smoke
 * check 64c (scripts/smoke-cdp.mjs), which clicks a plan step's chat icon in a real window with a positive control.
 */

describe('Genie asks for focus and never opts out of react-fancy’s no-scroll default', () => {
    function recorder(): DraftHandle & { options: unknown[] } {
        let draft: ChatDraft = { v: 1, text: '', pills: [], attachments: [] };
        const options: unknown[] = [];
        return { options, getDraft: () => draft, setDraft: (d, o) => { draft = d; options.push(o); } };
    }

    it('the person’s click: setDraft gets exactly { focus: true }, so preventScroll is react-fancy’s default (true)', () => {
        const h = recorder();
        expect(applyChatInsert(new Map([['a_b', h]]), planStepInsert('a_b', 'Run the suite', 1))).toBe(true);
        expect(h.options).toStrictEqual([{ focus: true }]);
    });

    it('CONTROL: an insert that is not a click still passes focus:false, and no scroll option either', () => {
        const h = recorder();
        applyChatInsert(new Map([['a_b', h]]), { ...planStepInsert('a_b', 'Run the suite', 2), focus: false });
        expect(h.options).toStrictEqual([{ focus: false }]);
    });

    it('nowhere in the renderer or the core does Genie pass preventScroll: false', () => {
        const root = fileURLToPath(new URL('../src', import.meta.url));
        const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.(ts|tsx)$/.test(f));
        // CONTROL: the scan reads the file that makes the call.
        expect(files.map((f) => f.replace(/\\/g, '/'))).toContain('core/plan-pill.ts');
        const optedOut = files.filter((f) => /preventScroll\s*:\s*false/.test(readFileSync(join(root, f), 'utf8')));
        expect(optedOut).toEqual([]);
    });
});

describe('the react-fancy Genie runs focuses without scrolling (5.69.0)', () => {
    it('its types carry the opt-out on both paths: setDraft’s options and focus()’s PromptFocusOptions', () => {
        // Type-level: on 5.68 `PromptFocusOptions` does not exist and `preventScroll` is an excess property (typecheck).
        const set: PromptSetDraftOptions = { focus: true, preventScroll: true };
        const focus: PromptFocusOptions = { preventScroll: true };
        expect([set, focus]).toHaveLength(2);
        const dts = readFileSync(new URL('../node_modules/@particle-academy/react-fancy/dist/prompt-input.d.ts', import.meta.url), 'utf8');
        expect(dts).toMatch(/\bPromptFocusOptions\b/);
    });

    it('its PromptInput defaults focus() AND setDraft({ focus: true }) to preventScroll: true', () => {
        const dist = fileURLToPath(new URL('../node_modules/@particle-academy/react-fancy/dist/', import.meta.url));
        const chunks = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8'));
        // CONTROL: exactly one ESM chunk is PromptInput's imperative handle (its own refusal message names it).
        const prompt = chunks.filter((c) => c.includes('PromptInput: setDraft ignored a draft'));
        expect(prompt).toHaveLength(1);
        const src = prompt[0]!;
        // The one focus routine both paths use: the default is no scroll.
        expect(src).toMatch(/preventScroll:\s*options\?\.preventScroll\s*\?\?\s*true/);
        // setDraft({ focus: true }) hands its option (undefined → that default) to the same routine.
        expect(src).toMatch(/if \(options\?\.focus\) pendingFocus\.current = \{ preventScroll: options\.preventScroll \}/);
        expect(src).toMatch(/focus: \(options\) => focusInput\(options\)/);
    });
});
