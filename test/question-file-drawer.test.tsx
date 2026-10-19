import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { QuestionApp, type QuestionAppView } from '../src/renderer/components/QuestionApp.js';

/**
 * THE QUESTION'S FILES, BESIDE IT — GENIE 1'S FILE DRAWER (the owner, 2026-10-19: "The Genie 1 FTQ ux was so much better
 * and included the context preview drawer"). A question that names `.ai/plans/spec.md` gets a chip for it; the chip opens
 * the file in a drawer beside the question (the window widens), Markdown as prose, anything else as code at the line the
 * question named. A named file that is not there is said, never offered as a chip.
 */

const item = {
    id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'atlas', workspaceId: 'tynn', title: 'Spec', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Spec', question: 'Does §3 of `.ai/plans/spec.md` still hold, given `src/core/route.ts:42`? See also `docs/gone.md`.', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem;
const view: QuestionAppView = { item, waiting: 0 };
const render = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} now={10_000} onOpenFile={() => {}} onCloseFile={() => {}} {...extra} />);

describe('the files a question names', () => {
    it('a chip per file that is there, in the order named, with its line or section; the missing one said, not offered', () => {
        const html = render({ existing: new Set(['.ai/plans/spec.md', 'src/core/route.ts']) });
        expect([...html.matchAll(/data-question-file="([^"]+)"/g)].map((m) => m[1])).toEqual(['.ai/plans/spec.md', 'src/core/route.ts']);
        expect(html).toMatch(/data-question-file="src\/core\/route.ts"[^>]*>[\s\S]*?:42/);
        expect(html).toMatch(/data-question-file-missing="docs\/gone.md"/);
        expect(html).not.toContain('data-question-file="docs/gone.md"');
    });

    it('existence unknown (the check failed): every named file is offered — fails OPEN, as Genie 1', () => {
        expect([...render({ existing: null }).matchAll(/data-question-file="([^"]+)"/g)]).toHaveLength(3);
    });
});

describe('the drawer', () => {
    it('open on a Markdown file: beside the question, named, the file as prose', () => {
        const html = render({ existing: null, drawer: { path: '.ai/plans/spec.md', text: '# Spec\n\n§3 **holds**.', line: null } });
        expect(html).toMatch(/data-question-drawer=".ai\/plans\/spec.md"/);
        expect(html).toMatch(/data-question-drawer[\s\S]*?spec\.md/);
        expect(html).toMatch(/<strong>holds<\/strong>/);
        expect(html).toContain('data-action="question-drawer-close"');
    });

    it('a refusal reads as the drawer’s sentence (outside the workspace, binary, missing)', () => {
        const html = render({ existing: null, drawer: { path: '../x.md', error: 'that file is not in this workspace' } });
        expect(html).toMatch(/data-question-drawer-error[^>]*>that file is not in this workspace</);
    });

    it('CONTROL: closed — no drawer at all', () => {
        expect(render({ existing: null })).not.toContain('data-question-drawer=');
    });
});
