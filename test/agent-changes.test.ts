import { describe, expect, it } from 'vitest';
import { agentChanges } from '../src/core/agent-changes.js';

/**
 * THE AGENT VIEW'S CHANGES TAB. The board audit of 2026-10-12: every tab but Stream rendered an empty body — a tab
 * that exists and shows nothing. Changes is the files THIS agent changed this session, from the file host's own
 * groups (§4.3: the agents' reports, never a guess). `null` = ABSENT — no file state, or this agent changed nothing —
 * so the tab says so in a sentence rather than drawing an empty list.
 */
describe('agentChanges', () => {
    const state = { changed: [{ who: 'you', files: ['config/auth.php'] }, { who: 'atlas', files: ['src/a.ts', 'src/b.ts'] }, { who: '?', files: ['notes.md'] }] };

    it("this agent's files, in the host's order — nobody else's, not yours, not the unattributed", () => {
        expect(agentChanges(state, 'atlas')).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('absent (null) when the host has nothing, when nothing changed, or when THIS agent changed nothing — three different nothings, one honest answer', () => {
        expect(agentChanges(null, 'atlas')).toBeNull();
        expect(agentChanges({ changed: null }, 'atlas')).toBeNull();
        expect(agentChanges({ changed: [] }, 'atlas')).toBeNull();
        expect(agentChanges(state, 'wren')).toBeNull();
        // POSITIVE CONTROL in the same run: the function does find files when they are there.
        expect(agentChanges(state, 'atlas')).toHaveLength(2);
    });
});
