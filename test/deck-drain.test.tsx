import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Deck } from '../src/renderer/components/Deck.js';
import type { SignalState } from '../src/core/deck.js';
import { updateChip } from '../src/core/update-chip.js';

/**
 * NO HANDOFF WAIT ON THE DECK (the owner, 2026-10-12: "agents no longer need to write a handoff when genie upgrades").
 * The roster of agents asked for handoffs, its quiet count and its Cancel are gone; an upgrade goes from "ready —
 * restart to install" straight to "Installing".
 */
const base: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };
const render = (signals: SignalState) =>
    renderToStaticMarkup(<Deck items={[]} signals={signals} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onSignalAction={() => {}} />);

describe('an upgrade on the Deck', () => {
    it('ready, then Installing — no roster, no waiting on agents, no Cancel', () => {
        // The notice itself is the header's now (core/update-chip.ts); the Deck still shows no roster and no Cancel.
        const ready = updateChip({ phase: 'downloaded', version: '2.0.0-beta.21', percent: 100 });
        expect(ready).toMatchObject({ label: 'Genie 2.0.0-beta.21 is ready — restart to install', action: 'update-install' });
        const installing = { ...base, update: { phase: 'installing' as const, version: '2.0.0-beta.21', percent: 100 } };
        expect(updateChip(installing.update)).toMatchObject({ label: 'Installing Genie 2.0.0-beta.21…' });
        const html = render(installing);
        expect(html).not.toContain('data-drain-roster');
        expect(html).not.toContain('update-cancel');
        expect(html).not.toMatch(/handoff/i);
    });
});
