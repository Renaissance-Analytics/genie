import { describe, expect, it } from 'vitest';
import { approvalFrom, type PermissionRequestLike } from '../src/core/approval.js';

/**
 * THE APPROVAL CARD'S DETAILS (the board): `atlas asks to run Bash`, `tool_call 7f3a · 1 of 1 pending`, the command
 * block. They come from the permission request's own tool call — its id, its name, its kind, the command in its
 * arguments — and each is `null` when the provider did not say. Nothing here changes which requests are answerable.
 */
const request = (toolCall: Record<string, unknown>, options: Record<string, unknown>[] = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]): PermissionRequestLike => ({ toolCall, options });

describe('approvalFrom carries the tool call', () => {
    it('the id, the tool, its kind, and the command from the arguments', () => {
        const a = approvalFrom(request({ toolCallId: 'toolu_7f3a9c', title: 'php artisan migrate --force', name: 'Bash', kind: 'execute', rawInput: { command: 'php artisan migrate --force' } }));
        expect(a).toMatchObject({ question: 'php artisan migrate --force', toolCallId: 'toolu_7f3a9c', tool: 'Bash', kind: 'execute', command: 'php artisan migrate --force' });
    });

    it('each detail is null when the provider did not say — never guessed from the title', () => {
        const a = approvalFrom(request({ title: 'Edit src/a.ts' }));
        expect(a).toMatchObject({ question: 'Edit src/a.ts', toolCallId: null, tool: null, kind: null, command: null });
    });

    it('a command that is not a string is not a command', () => {
        expect(approvalFrom(request({ title: 'x', rawInput: { command: ['php', 'artisan'] } }))?.command).toBeNull();
    });
});
