import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE FORCETHEQUESTION WINDOW IS WIRED AND BUILT (the owner, 2026-10-14: "the FTQ window is a window that opens on top
 * of all other windows"). Its behaviour is in question-window.test.tsx; this file holds what makes it exist in the app:
 * main creates it from the Deck's items and re-checks it on every attention change, and its page and preload are built.
 */
describe('Genie wires it', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('main makes the window from the Deck’s items and re-checks it on every attention change', () => {
        const main = strip('../src/main/main.ts');
        expect(main.match(/new QuestionWindow\(\{/g) ?? []).toHaveLength(1);
        expect(main.match(/items:\s*\(\)\s*=>\s*composed\.deckItems\(\)/g) ?? []).toHaveLength(1);
        expect(main.match(/composed\.attention\.onChange\(\(\)\s*=>\s*questionWindow\?\.changed\(\)\)/g) ?? []).toHaveLength(1);
    });
    it('the window’s page and preload are built', () => {
        expect(strip('../vite.config.ts')).toMatch(/question:\s*'question\.html'/);
        expect(strip('../vite.preload.config.ts')).toMatch(/'question-preload':\s*'src\/main\/question-preload\.ts'/);
    });
});
