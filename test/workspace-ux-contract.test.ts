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
const contract = JSON.parse(bytes) as { $id: string; contract: string; version: string; surfaces: Array<{ id: string } & Board> };
/** The pin beside the copy: the published tag of Civicognita/shared-schemas this repo declares against, and its bytes' hash. */
const pin = JSON.parse(readFileSync(new URL('../contracts/workspace-ux.pin.json', import.meta.url), 'utf8')) as {
    repository: string; contract: string; version: string; tag: string; commit: string; path: string; sha256: string;
};
const board = contract.surfaces.find((s) => s.id === 'board')!;

describe('the contract file', () => {
    it('pins a PUBLISHED contract: a tag of Civicognita/shared-schemas, its commit, its path and the sha256 of its bytes', () => {
        expect(pin.repository).toBe('Civicognita/shared-schemas');
        expect(pin.contract).toBe('workspace-ux');
        expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pin.tag).toBe(`workspace-ux/v${pin.version}`);
        expect(pin.path).toBe(`contracts/workspace-ux/${pin.version}/workspace-ux.json`);
        expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is not stale: the copy here is byte for byte the pinned tag\'s contract (it changes in shared-schemas first)', () => {
        // No network: shared-schemas is private and this repo's CI is public, so the pin RECORDS the published bytes'
        // hash (LF line ends) and the copy is held to it.
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
        expect(contract.contract).toBe(pin.contract);
        expect(contract.version).toBe(pin.version);
        expect(contract.$id).toBe(`https://raw.githubusercontent.com/${pin.repository}/${pin.tag}/${pin.path}`);
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
