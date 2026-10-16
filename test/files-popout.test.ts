import { describe, expect, it } from 'vitest';
import { DOCK_WIDTH } from '../src/core/dock.js';
import { filesDock, pauseMessage, pauseRequests, resumeMessage, resumed } from '../src/core/files-popout.js';

/**
 * THE FILE PANEL POPPED OUT, AND THE AGENT PAUSED ON A CONFLICTED FILE (§4.3) — the pure half.
 *
 * Popped out, the one panel "releases the dock reserve; a bar brings it back": the slot stays pinned
 * to that workspace (the lamp is still on), but the content row gets its width back and the dock
 * column is a bar, not the panel. And "you can type in the same file an agent is editing… the agent
 * pauses on that file": Genie cannot stop a provider's tool call mid-flight, so the pause is an ASK —
 * a message to the agent, once per episode, lifted when the buffer is clean again — and the panel
 * says "asked", never "stopped".
 */

describe('filesDock', () => {
    it('pinned and on screen: docked with the full reserve; pinned and popped out: the reserve is released, the slot still names the workspace', () => {
        expect(filesDock({ pinned: 'files', filesWorkspaceId: 'tynn', popped: [] })).toEqual({ kind: 'docked', workspaceId: 'tynn', reserve: DOCK_WIDTH });
        expect(filesDock({ pinned: 'files', filesWorkspaceId: 'tynn', popped: ['tynn'] })).toEqual({ kind: 'popped', workspaceId: 'tynn', reserve: 0 });
        // Another workspace's panel popped out does not touch this slot.
        expect(filesDock({ pinned: 'files', filesWorkspaceId: 'tynn', popped: ['fancy'] })).toEqual({ kind: 'docked', workspaceId: 'tynn', reserve: DOCK_WIDTH });
    });

    it('not pinned, or chat pinned, or pinned with no workspace: none', () => {
        expect(filesDock({ pinned: null, filesWorkspaceId: 'tynn', popped: ['tynn'] })).toEqual({ kind: 'none', workspaceId: null, reserve: 0 });
        expect(filesDock({ pinned: 'chat', filesWorkspaceId: 'tynn', popped: [] })).toEqual({ kind: 'none', workspaceId: null, reserve: 0 });
        expect(filesDock({ pinned: 'files', filesWorkspaceId: null, popped: [] })).toEqual({ kind: 'none', workspaceId: null, reserve: 0 });
    });
});

describe('pauseRequests / resumed', () => {
    const activity = [
        { agent: 'kora', verb: 'writing' as const, path: 'src/ipc.ts' },
        { agent: 'zane', verb: 'reading' as const, path: 'src/ipc.ts' },
        { agent: 'wren', verb: 'writing' as const, path: 'model.ts' },
    ];

    it('an agent WRITING a file you have dirty is asked to pause — once; reading is not a conflict; a clean file is not', () => {
        expect(pauseRequests(activity, ['src/ipc.ts'], [])).toEqual([{ agent: 'kora', path: 'src/ipc.ts' }]);
        expect(pauseRequests(activity, ['src/ipc.ts'], [{ agent: 'kora', path: 'src/ipc.ts' }])).toEqual([]);
        expect(pauseRequests(activity, ['other.ts'], [])).toEqual([]);
        expect(pauseRequests(activity, [], [])).toEqual([]);
        expect(pauseRequests(activity, ['src/ipc.ts', 'model.ts'], [])).toEqual([{ agent: 'kora', path: 'src/ipc.ts' }, { agent: 'wren', path: 'model.ts' }]);
    });

    it('a pause is lifted when the buffer is clean again (saved or reverted), not when the agent stops writing', () => {
        const paused = [{ agent: 'kora', path: 'src/ipc.ts' }, { agent: 'wren', path: 'model.ts' }];
        expect(resumed(paused, ['src/ipc.ts'])).toEqual([{ agent: 'wren', path: 'model.ts' }]);
        expect(resumed(paused, [])).toEqual(paused);
        expect(resumed(paused, ['src/ipc.ts', 'model.ts'])).toEqual([]);
    });

    it('the messages name the file and the person, and say what the agent may still do', () => {
        expect(pauseMessage('src/ipc.ts')).toMatch(/unsaved edits/);
        expect(pauseMessage('src/ipc.ts')).toContain('src/ipc.ts');
        expect(pauseMessage('src/ipc.ts')).toMatch(/do not write to it/i);
        expect(resumeMessage('src/ipc.ts')).toContain('src/ipc.ts');
        expect(resumeMessage('src/ipc.ts')).toMatch(/may write to it again/i);
    });
});
