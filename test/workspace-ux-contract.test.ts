import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    BOARD_API,
    BOARD_DATA_API,
    BOARD_DRAG,
    BOARD_FIELDS,
    BOARD_GAPS,
    BOARD_LEVELS,
    BOARD_QUICK_ACTIONS,
    BOARD_STATES,
    BOARD_TRANSITIONS,
} from '../src/core/tynn-board.js';

/**
 * THE WORKSPACE-UX DRIFT WATCHER, Genie's side (genie#1295).
 *
 * The owner, 2026-10-27: "our CI and active spec documentation should include a drift watcher on workspace UX (not just
 * ui). tynn and genie and genie cloud (and supporting repos) are tightly connected and need to stay in sync."
 *
 * contracts/workspace-ux.json says, surface by surface, what a person can DO, what they SEE, and the Tynn API each action
 * uses. tynn.ai checks its side of the same file (its routes, its state machines, its web board's own rules); this checks
 * Genie's: the Tynn tab's declared behaviour in src/core/tynn-board.ts must be the contract's, action for action. An
 * action Genie does not offer yet is named in BOARD_GAPS with the reason — never silently missing.
 */
type Api = { method: string; path: string } | null;
type Action = { id: string; web: string; api: Api; to?: string };
type Board = {
    data: {
        api: { method: string; path: string };
        levels: Record<string, { scope: string; columns: string[] }>;
        fields: Record<string, string[]>;
        drag: Record<string, unknown>;
        transitions: Record<string, Record<string, string[]>>;
        quickActions: Record<string, Record<string, { verb: string; guard?: string }>>;
    };
    states: Array<{ id: string }>;
    actions: Action[];
};

const bytes = readFileSync(new URL('../contracts/workspace-ux.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const contract = JSON.parse(bytes) as { contract: string; surfaces: Array<{ id: string } & Board> };
const board = contract.surfaces.find((s) => s.id === 'board')!;

describe('the contract file', () => {
    it('is the pinned one: it changes in its canonical home first, then here, re-pinned', () => {
        const pin = readFileSync(new URL('../contracts/workspace-ux.sha256', import.meta.url), 'utf8').trim();
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin);
        expect(contract.contract).toBe('workspace-ux');
        expect(board).toBeDefined();
    });
});

describe('the Tynn tab\'s board, against the contract', () => {
    it('reads the board where the contract says', () => {
        expect(BOARD_DATA_API).toEqual(board.data.api);
    });

    it('calls exactly the contract\'s API for every action it offers, and names every action it does not', () => {
        const ids = new Set(board.actions.map((a) => a.id));
        for (const action of board.actions) {
            const offered = BOARD_API[action.id];
            if (offered) expect({ id: action.id, ...offered }).toEqual({ id: action.id, ...action.api });
            else expect(BOARD_GAPS[action.id], `${action.id} is neither offered nor a named gap`).toMatch(/\S/);
            // An action Tynn has no API for cannot be offered: it is a gap until Tynn adds one.
            if (action.api === null) expect(BOARD_API[action.id]).toBeUndefined();
        }
        // Nothing offered or excused that the contract does not name.
        for (const id of [...Object.keys(BOARD_API), ...Object.keys(BOARD_GAPS)]) expect(ids.has(id), `${id} is not in the contract`).toBe(true);
        // Not both.
        for (const id of Object.keys(BOARD_API)) expect(BOARD_GAPS[id]).toBeUndefined();
    });

    it('shows the contract\'s levels, columns and card fields', () => {
        expect(BOARD_LEVELS).toEqual(board.data.levels);
        expect(BOARD_FIELDS).toEqual(board.data.fields);
    });

    it('drags, gates drops and offers each card\'s next step by the contract\'s rules', () => {
        expect(BOARD_DRAG).toEqual(board.data.drag);
        expect(BOARD_TRANSITIONS).toEqual(board.data.transitions);
        expect(BOARD_QUICK_ACTIONS).toEqual(board.data.quickActions);
    });

    it('has a view for every state the contract names', () => {
        expect([...BOARD_STATES].sort()).toEqual(board.states.map((s) => s.id).sort());
    });

    it('offers every quick action through an API it has (a button with no call behind it is not offered)', () => {
        for (const [kind, steps] of Object.entries(BOARD_QUICK_ACTIONS)) {
            for (const step of Object.values(steps)) expect(BOARD_API[`${kind}.${step.verb}`], `${kind}.${step.verb}`).toBeDefined();
        }
    });
});
