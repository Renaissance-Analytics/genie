import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USER_INPUT_GRACE_MS, composerFocusLine } from '../src/core/composer-focus.js';

/**
 * THE COMPOSER-FOCUS LOG (genie#1235): the chat composer taking the caret with no click or key in Genie is logged with
 * the call that moved it, and main writes the line to its own log — so the owner's next report names its cause.
 */

const STACK = ['Error', '    at HTMLDocument.onFocusIn (App.tsx:10:1)', '    at InlinePasteEditor.focus (chunk.js:527:16)', '    at ChatFlyout.effect (ChatFlyout.tsx:300:5)'].join('\n');

describe('composerFocusLine', () => {
    it('a focus nobody clicked or typed for: logged, with the call that moved it', () => {
        const line = composerFocusLine({ inComposer: true, windowFocused: false, sinceUserInputMs: 60_000, from: 'input[data-ftq-answer]', stack: STACK });
        expect(line).toBe('[genie] focus: the chat composer took the caret with no click or key in Genie (window not focused, from input[data-ftq-answer]); at InlinePasteEditor.focus (chunk.js:527:16) <- at ChatFlyout.effect (ChatFlyout.tsx:300:5)');
    });

    it('a focus with no page caller says so: the window was activated and the browser put the caret back', () => {
        expect(composerFocusLine({ inComposer: true, windowFocused: true, sinceUserInputMs: null, from: 'none', stack: 'Error\n    at HTMLDocument.onFocusIn (App.tsx:10:1)' }))
            .toMatch(/no page caller \(the window was activated and the browser restored the caret\)$/);
    });

    it('CONTROL: the person’s own click or key is not logged; nor is focus anywhere but the composer', () => {
        expect(composerFocusLine({ inComposer: true, windowFocused: true, sinceUserInputMs: USER_INPUT_GRACE_MS - 1, from: 'none', stack: STACK })).toBeNull();
        expect(composerFocusLine({ inComposer: false, windowFocused: false, sinceUserInputMs: 60_000, from: 'none', stack: STACK })).toBeNull();
        expect(composerFocusLine({ inComposer: true, windowFocused: true, sinceUserInputMs: USER_INPUT_GRACE_MS, from: 'none', stack: STACK })).not.toBeNull();
    });
});

describe('the wiring', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the window listens for focusin in the capture phase and the person’s pointer and keys, and logs the line', () => {
        const hook = strip('../src/renderer/composer-focus-log.ts');
        expect(hook).toMatch(/document\.addEventListener\('focusin', onFocusIn, true\)/);
        expect(hook).toMatch(/window\.addEventListener\('pointerdown', onInput, true\)/);
        expect(hook).toMatch(/window\.addEventListener\('keydown', onInput, true\)/);
        expect(hook).toMatch(/const line = composerFocusLine\(\{/);
        expect(hook).toMatch(/if \(line\) console\.warn\(line\)/);
        // Both windows with a chat composer: Genie's and the doctor's.
        expect(strip('../src/renderer/App.tsx')).toMatch(/^\s*useComposerFocusLog\(\);$/m);
        expect(strip('../src/renderer/DoctorApp.tsx')).toMatch(/^\s*useComposerFocusLog\(\);$/m);
    });

    it('main writes the renderer’s focus lines to its own log (the renderer console reaches no file) — both windows', () => {
        // Through core/render-error.ts's forwardRendererConsole since parity audit #7, which sends a focus line to main's
        // output exactly as before (test/render-error-log.test.ts holds that routing).
        const forward = /win[.]webContents[.]on[(]'console-message', [(]details[)] => forwardRendererConsole[(]details[.]message, [{] out: [(]l[)] => console[.]log[(]l[)]/;
        expect(strip('../src/main/main.ts')).toMatch(forward);
        expect(strip('../src/main/doctor.ts')).toMatch(forward);
    });
});
