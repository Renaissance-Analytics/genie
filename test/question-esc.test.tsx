import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { questionWindowAction } from '../src/core/keys.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';

/**
 * ESC IN THE FORCETHEQUESTION WINDOW (Tynn #759; Genie 1 inventory row 85 — its ask.tsx and main/ask/force-question.ts at
 * v0.7.0-beta.342). Genie 1: "PARK, never kill. Escape, the X and the dismiss button all land here, and none of them is a
 * decision to give up on the question — they are 'get this off my screen'." So Esc is LATER — the question stays in
 * Pending Questions, its draft kept — and never Dismiss, which tells the agent. With a file open beside the question
 * (row 84, when it lands) Esc puts the FILE away first: someone checking a file meant the file, not the question.
 */
const press = (key: string, mod: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}, typing = false) => ({
    key,
    ctrlKey: mod.ctrl ?? false,
    metaKey: mod.meta ?? false,
    altKey: mod.alt ?? false,
    shiftKey: mod.shift ?? false,
    typing,
});

describe('the key', () => {
    it('Esc is Later — even while typing a note (the draft is kept); a file open beside it is put away first', () => {
        expect(questionWindowAction(press('Escape'), { drawerOpen: false })).toBe('later');
        expect(questionWindowAction(press('Escape', {}, true), { drawerOpen: false })).toBe('later');
        expect(questionWindowAction(press('Escape'), { drawerOpen: true })).toBe('close-drawer');
    });

    it('a modified Esc, or any other key, is not the window’s', () => {
        expect(questionWindowAction(press('Escape', { ctrl: true }), { drawerOpen: false })).toBeNull();
        expect(questionWindowAction(press('Escape', { shift: true }), { drawerOpen: false })).toBeNull();
        expect(questionWindowAction(press('Enter'), { drawerOpen: false })).toBeNull();
        expect(questionWindowAction(press('d'), { drawerOpen: false })).toBeNull();
    });
});

describe('the window', () => {
    const item = {
        id: 'q1', source: 'agent-question', agentId: 'agent_q1', agentName: 'kai', workspaceId: 'ws_01HTYNN', workspaceName: 'Tynn.ai', title: 'Pick', blocking: false, priority: 'normal', at: 1,
        answer: { kind: 'form', fields: 1, questions: [{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
        forwardedFrom: null,
    } as unknown as DeckItem;

    it('Later names its key; Dismiss does not (Esc never tells the agent)', () => {
        const html = renderToStaticMarkup(<QuestionApp view={{ item, waiting: 0 }} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} />);
        expect(html).toMatch(/data-action="question-cancel"[^>]*aria-keyshortcuts="Escape"|aria-keyshortcuts="Escape"[^>]*data-action="question-cancel"/);
        expect(html).toMatch(/title="Later \(Esc\)"/);
        expect(html.match(/aria-keyshortcuts="Escape"/g)?.length).toBe(1);
    });

    it('the window listens for the key and answers it with Later', () => {
        const source = readFileSync('src/renderer/components/QuestionApp.tsx', 'utf8');
        expect(source).toContain('questionWindowAction(');
        expect(source).toContain("window.addEventListener('keydown'");
        expect(source).toMatch(/=== 'later'\)\s*\{?\s*[^}]*onLater\(\)/);
    });
});
