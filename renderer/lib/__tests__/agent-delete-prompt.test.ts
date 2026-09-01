import { describe, expect, it } from 'vitest';
import { AGENT_DELETE_CHOICES, agentDeleteConfirmLabel } from '../agent-delete-prompt';

/**
 * The copy behind the delete confirm dialog (genie#311).
 *
 * The issue is explicit: "The prompt must state plainly which files are kept
 * and which are removed; 'unmount' vs 'delete' is exactly the distinction a
 * user cannot recover from if it is guessed wrong." So the two choices' body
 * text is asserted here, not just their existence — a choice with a vague or
 * swapped description would pass every other test in this feature and still
 * ship the exact mistake the issue calls out.
 *
 * PURE, like agent-card-menu.ts — testable without a DOM.
 */
describe('AGENT_DELETE_CHOICES', () => {
    it('offers exactly the two choices the issue asks for, unmount before delete', () => {
        expect(AGENT_DELETE_CHOICES.map((c) => c.mode)).toEqual(['unmount', 'delete']);
    });

    it('states plainly that UNMOUNT keeps every .agents/* file', () => {
        const unmount = AGENT_DELETE_CHOICES.find((c) => c.mode === 'unmount')!;
        expect(unmount.body).toMatch(/keep|kept/i);
        expect(unmount.body).toMatch(/\.agents/);
        // The opposite claim must never sneak into this copy — that would be
        // the exact guess-wrong-with-no-recovery the issue warns about.
        expect(unmount.body).not.toMatch(/remov/i);
    });

    it('states plainly that DELETE removes the .agents/* files too', () => {
        const del = AGENT_DELETE_CHOICES.find((c) => c.mode === 'delete')!;
        expect(del.body).toMatch(/remov/i);
        expect(del.body).toMatch(/\.agents/);
    });

    it('every choice carries a non-empty label and body', () => {
        for (const choice of AGENT_DELETE_CHOICES) {
            expect(choice.label.trim().length).toBeGreaterThan(0);
            expect(choice.body.trim().length).toBeGreaterThan(0);
        }
    });
});

describe('agentDeleteConfirmLabel', () => {
    it('names the safe action for unmount', () => {
        expect(agentDeleteConfirmLabel('unmount')).toBe('Unmount');
    });

    it('names the destructive action for delete, plainly, not "Confirm"', () => {
        expect(agentDeleteConfirmLabel('delete')).toBe('Delete for real');
    });
});
