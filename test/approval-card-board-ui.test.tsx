import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Approval } from '../src/core/approval.js';
import { ApprovalCard } from '../src/renderer/components/ApprovalCard.js';

/**
 * THE APPROVAL CARD ON SCREEN (the board): the heading `atlas asks to run Bash`, the meta `tool_call 7f3a · 1 of 1
 * pending` (Genie parks one approval per agent), the command in a block, the key hints `A` / `D` on the allow and
 * deny options. Each piece drawn only when it was reported; a bare question renders as before.
 */
const full: Approval = {
    question: 'php artisan migrate --force', toolCallId: 'toolu_7f3a9c', tool: 'Bash', kind: 'execute', command: 'php artisan migrate --force',
    options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }],
};
const bare: Approval = { question: 'Edit src/a.ts', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] };
const render = (approval: Approval, agentName?: string) =>
    renderToStaticMarkup(<ApprovalCard approval={approval} answering={null} onAnswer={() => {}} agentName={agentName} />);

describe('the approval card', () => {
    it('heading, meta, the command block, the key hints', () => {
        const html = render(full, 'atlas');
        expect(html).toMatch(/data-approval-heading[^>]*>[^<]*atlas asks to run Bash/);
        expect(html).toMatch(/data-approval-meta[^>]*>[^<]*tool_call 7f3a · 1 of 1 pending/);
        expect(html).toMatch(/data-approval-command[^>]*>[^<]*php artisan migrate --force/);
        expect(html).toMatch(/data-approval-option="allow"[\s\S]*?data-key-hint="A"/);
        expect(html).toMatch(/data-approval-option="deny"[\s\S]*?data-key-hint="D"/);
    });

    it('a bare question: no heading, no meta, no command — the question and its options as before', () => {
        const html = render(bare);
        expect(html).toContain('data-approval-question');
        expect(html).not.toContain('data-approval-heading');
        expect(html).not.toContain('data-approval-meta');
        expect(html).not.toContain('data-approval-command');
    });

    it('with the tool but no agent name the heading still names the tool', () => {
        expect(render({ ...bare, tool: 'Bash' })).toMatch(/data-approval-heading[^>]*>[^<]*asks to run Bash/);
    });
});
