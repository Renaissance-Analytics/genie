import { describe, expect, it } from 'vitest';
import { agentDeleteBusyLabel, handoffOfferFor } from '../agent-delete-prompt';

/**
 * Offer to take a handoff BEFORE stopping an agent.
 *
 * Unmount and Delete both stop the agent and its sidecars. That is the last
 * moment the agent is still there to be asked what it was doing — once its
 * terminal is gone, whatever it had in flight is unrecoverable and nobody can
 * ask it anything.
 *
 * The offer is only real when the agent is RUNNING. A dormant agent has no
 * conversation to summarise, and offering anyway would be a checkbox that
 * cannot do what it says — the failure this codebase keeps having to fix.
 */

describe('the handoff offer on stopping an agent', () => {
    it('is offered when the agent is running', () => {
        const offer = handoffOfferFor({ running: true, mode: 'unmount' });

        expect(offer.available).toBe(true);
        expect(offer.label).toMatch(/handoff/i);
    });

    it('is offered for delete too — the note outlives the files', () => {
        // Unmount keeps `.agents/*`; delete does not. The handoff lives in
        // `.ai/handoff/`, so it survives either, and is MORE valuable when the
        // agent's own files are about to go.
        expect(handoffOfferFor({ running: true, mode: 'delete' }).available).toBe(true);
    });

    it('is NOT offered when the agent is not running', () => {
        // POSITIVE CONTROL: a dormant agent has no live conversation to ask, so
        // a checkbox here would promise something nothing can deliver.
        const offer = handoffOfferFor({ running: false, mode: 'unmount' });

        expect(offer.available).toBe(false);
    });

    it('says what happens if you decline', () => {
        // Declining is a real choice and must not be silent about its cost.
        const offer = handoffOfferFor({ running: true, mode: 'delete' });

        expect(offer.hint).toMatch(/without one|no note|lost/i);
    });

    it('never claims a handoff can be taken from a stopped agent', () => {
        const offer = handoffOfferFor({ running: false, mode: 'delete' });

        expect(offer.hint ?? '').not.toMatch(/will be asked/i);
    });
});

describe('what the button says while it waits', () => {
    it('names the agent it is waiting on when a handoff was asked for', () => {
        // The wait is up to 45s. A generic "Working…" for that long reads as
        // the dialog having hung, and the person cancels a stop that was in
        // fact doing exactly what they ticked.
        expect(agentDeleteBusyLabel({ agentName: 'tynn', handoff: true })).toMatch(/tynn/);
    });

    it('does not claim to be waiting when no handoff was asked for', () => {
        // POSITIVE CONTROL: with the box unticked nothing is being asked, and
        // saying otherwise would be the dialog describing work it is not doing.
        const label = agentDeleteBusyLabel({ agentName: 'tynn', handoff: false });
        expect(label).not.toMatch(/tynn/);
        expect(label).toMatch(/…$/);
    });
});
