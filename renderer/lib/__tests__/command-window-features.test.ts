import { describe, expect, it } from 'vitest';
import { featureCommandItems, dropUndeliverable } from '../command-window';
import { FEATURE_SURFACES } from '../feature-reachability';

/**
 * Widening the palette, and unscoping it from terminal focus.
 *
 * Two measured facts made P7's deletions unsafe:
 *
 *   1. the palette opened only "while a terminal panel has focus"
 *      (`master.tsx:3086`) — and the Deck focuses no terminal, so under Genie 2 it
 *      would never have opened at all; and
 *   2. it offered workspaces, terminals and prompts, and NO feature entries — so the
 *      eight icons P7 deletes had nowhere to survive.
 *
 * Unscoping introduces a defect of its own if done naively: `prompts` are SENT TO a
 * terminal, so with none focused a prompt entry has no destination. Offering one would be
 * a row that silently does nothing — worse than not offering it. That is the rule
 * `dropUndeliverable` exists for, and most of what is asserted here.
 *
 * Feature items are built FROM the reachability contract, so a feature cannot be added to
 * the contract and forgotten in the palette. One source of truth, by construction.
 */

describe('featureCommandItems', () => {
    const items = featureCommandItems(FEATURE_SURFACES);

    it('offers one entry per contracted feature', () => {
        expect(items).toHaveLength(FEATURE_SURFACES.length);
        expect(items.length).toBeGreaterThanOrEqual(12);
    });

    it('carries the featureId, which is how the reachability guard sees coverage', () => {
        const ids = items.map((i) => i.featureId);
        expect(ids).toContain('remote-host');
        expect(ids).toContain('plugins-appstore');
        expect(ids).toContain('knowledge-graph');
        expect(ids).toContain('agent-inbox');
    });

    it('files them under panel — a place it navigates to, reachable by the s> prefix', () => {
        // Not a new category. `panel` already means exactly this, and a category with no
        // type-ahead prefix is not reachable in a keyboard-first palette.
        expect(new Set(items.map((i) => i.category))).toEqual(new Set(['panel']));
    });

    it('labels them with the human name, because that is what the query matches', () => {
        const knowledge = items.find((i) => i.featureId === 'knowledge-graph');
        expect(knowledge?.label).toMatch(/Knowledge/);
    });
});

describe('dropUndeliverable — the unscoping safety rule', () => {
    const base = [
        { id: 'p1', category: 'prompt' as const, label: 'Review my last 5 commits' },
        { id: 'w1', category: 'workspace' as const, label: 'tynn' },
        { id: 'f1', category: 'panel' as const, label: 'Knowledge graph', featureId: 'knowledge-graph' },
        { id: 't1', category: 'terminal' as const, label: 'kai' },
        { id: 'a1', category: 'action' as const, label: 'Launch the GApp' },
    ];

    it('keeps everything when a terminal is focused', () => {
        expect(dropUndeliverable(base, { hasTerminal: true })).toHaveLength(5);
    });

    it('DROPS prompts when no terminal is focused — they would have nowhere to go', () => {
        // The defect unscoping would otherwise introduce: a prompt row that looks live and
        // silently does nothing, because `onSendPrompt` needs a terminal id.
        const out = dropUndeliverable(base, { hasTerminal: false });
        expect(out.map((i) => i.id)).not.toContain('p1');
    });

    it('DROPS terminal entries too when there are none to focus', () => {
        const out = dropUndeliverable([{ id: 't1', category: 'terminal' as const, label: 'kai' }], {
            hasTerminal: false,
        });
        expect(out).toEqual([]);
    });

    it('KEEPS features and workspaces with no terminal — the whole point of unscoping', () => {
        // On the Deck there is no terminal, and this is exactly when a person needs to
        // reach Hosts, Knowledge or the App Store.
        const out = dropUndeliverable(base, { hasTerminal: false });
        expect(out.map((i) => i.id)).toContain('f1');
        expect(out.map((i) => i.id)).toContain('w1');
    });

    it('keeps actions with no terminal, because a verb need not target one', () => {
        // Launching a GApp happens in a workspace, not in a shell.
        expect(dropUndeliverable(base, { hasTerminal: false }).map((i) => i.id)).toContain('a1');
    });

    it('does not mutate its input', () => {
        const copy = [...base];
        dropUndeliverable(base, { hasTerminal: false });
        expect(base).toEqual(copy);
    });
});
