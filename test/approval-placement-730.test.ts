import { describe, expect, it } from 'vitest';
import { approvalPlacement } from '../src/core/agent-view.js';

/**
 * THE TOAST IS THE ACTIONABLE PLACE (Tynn #730): while the approval toasts carry an agent's approval, the agent's page and its
 * chat show a marker and the toast holds the only buttons — still exactly one place per approval.
 */
describe('approvalPlacement with the toasts', () => {
    it('an approval a toast carries is actionable in the toast, wherever the chat is', () => {
        expect(approvalPlacement('kai', 'kai', true)).toBe('toast');
        expect(approvalPlacement('kai', null, true)).toBe('toast');
        expect(approvalPlacement('kai', 'wren', true)).toBe('toast');
    });

    it('CONTROL: when no toast carries it (Do Not Disturb holds it back, a remote window has none), the composer place is unchanged', () => {
        expect(approvalPlacement('kai', 'kai', false)).toBe('chat');
        expect(approvalPlacement('kai', null, false)).toBe('stream');
        expect(approvalPlacement('kai', 'kai')).toBe('chat');
    });

    it('still one place per input: all three are reachable and never two at once', () => {
        const results = [approvalPlacement('a', 'a', false), approvalPlacement('a', null, false), approvalPlacement('a', 'a', true)];
        expect(new Set(results)).toEqual(new Set(['chat', 'stream', 'toast']));
    });
});
