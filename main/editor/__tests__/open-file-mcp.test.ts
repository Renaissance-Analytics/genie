import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ipcMain } from 'electron';
import { openFileForUserForMcp, registerOpenFile } from '../open-file';

/**
 * The `openFileForUser` MCP tool END TO END through main: terminal → workspace →
 * resolved path → the payload the renderer Floor is handed.
 *
 * The payload is the contract that broke in the field: an agent asked for
 * `.ai/plans/civic-commons-curriculum.md` and the editor tried to read
 * `<workspace>/civic-commons-curriculum.md` — the directories were gone. What
 * main SENDS (root + relPath + workspaceId) is what the panel resolves against,
 * so these pin the payload, not just the pure planner.
 */

type ReplyHandler = (
    e: unknown,
    requestId: string,
    result: { reused?: boolean; opened?: boolean },
) => unknown;

/** The reply IPC `registerOpenFile` installs — the test plays the renderer. */
let reply: ReplyHandler | null = null;

let tmp = '';
/** Two registered workspaces — the caller's, and the one that owns the file. */
let wsA = '';
let wsB = '';

/** Every open-file payload main pushed to the Floor, in order. */
const sent: Array<{
    requestId: string;
    workspaceId: string;
    root: string;
    relPath: string;
    line?: number;
}> = [];

/** What the fake renderer replies with when a payload arrives. */
let rendererReply: { reused: boolean; opened: boolean } | null = { reused: true, opened: false };

beforeAll(() => {
    (ipcMain as unknown as { handle: (ch: string, fn: ReplyHandler) => void }).handle = (
        ch,
        fn,
    ) => {
        if (ch === 'editor:open-file-result') reply = fn;
    };

    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-openfile-')));
    wsA = path.join(tmp, 'civi-ops.agi');
    wsB = path.join(tmp, 'civicognita-web.agi');
    fs.mkdirSync(path.join(wsA, '.ai', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(wsB, '.ai', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(wsA, '.ai', 'plans', 'roadmap.md'), '# roadmap\n');
    fs.writeFileSync(path.join(wsB, '.ai', 'plans', 'civic-commons-curriculum.md'), '# plan\n');

    registerOpenFile({
        workspaceIdOfTerminal: (terminalId) =>
            terminalId === 'term-a' ? 'ws-a' : terminalId === 'term-sys' ? '__system__' : null,
        getWorkspaceRoot: (id) => (id === 'ws-a' ? wsA : id === 'ws-b' ? wsB : null),
        homeDir: () => tmp,
        listWorkspaces: () => [
            { id: 'ws-a', path: wsA },
            { id: 'ws-b', path: wsB },
        ],
        sendOpenFile: (payload) => {
            sent.push(payload);
            // Play the renderer: answer the request main is awaiting.
            if (rendererReply) reply?.(null, payload.requestId, rendererReply);
        },
    });
});

afterEach(() => {
    sent.length = 0;
    rendererReply = { reused: true, opened: false };
});

afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('openFileForUser (main → Floor payload)', () => {
    it('sends the FULL workspace-relative path for a file in a subdirectory', async () => {
        const res = await openFileForUserForMcp('term-a', { path: '.ai/plans/roadmap.md' });
        expect(res.ok).toBe(true);
        expect(res.file).toBe(path.join(wsA, '.ai', 'plans', 'roadmap.md'));
        expect(sent).toHaveLength(1);
        expect(sent[0].workspaceId).toBe('ws-a');
        expect(sent[0].root).toBe(wsA);
        expect(sent[0].relPath).toBe('.ai/plans/roadmap.md');
    });

    it('reports the renderer REUSING an open panel', async () => {
        rendererReply = { reused: true, opened: false };
        const res = await openFileForUserForMcp('term-a', { path: '.ai/plans/roadmap.md' });
        expect(res.reused).toBe(true);
        expect(res.openedNew).toBe(false);
    });

    it('reports a NEW panel when the renderer had none to reuse', async () => {
        rendererReply = { reused: false, opened: true };
        const res = await openFileForUserForMcp('term-a', { path: '.ai/plans/roadmap.md' });
        expect(res.reused).toBe(false);
        expect(res.openedNew).toBe(true);
    });

    it('routes a file that lives in ANOTHER workspace to that workspace', async () => {
        const file = path.join(wsB, '.ai', 'plans', 'civic-commons-curriculum.md');
        const res = await openFileForUserForMcp('term-a', { path: file });
        expect(res.ok).toBe(true);
        expect(res.workspaceId).toBe('ws-b');
        expect(sent).toHaveLength(1);
        // The panel must root at the OWNING workspace with the full relative
        // path — rooting at the file's directory while the panel stays attached
        // to ws-a is what produced `<ws-a>/civic-commons-curriculum.md`.
        expect(sent[0].workspaceId).toBe('ws-b');
        expect(sent[0].root).toBe(wsB);
        expect(sent[0].relPath).toBe('.ai/plans/civic-commons-curriculum.md');
    });

    it('opens a file no workspace owns as a System panel rooted at its directory', async () => {
        const loose = path.join(tmp, 'loose', 'notes.md');
        fs.mkdirSync(path.dirname(loose), { recursive: true });
        fs.writeFileSync(loose, 'notes\n');
        const res = await openFileForUserForMcp('term-a', { path: loose });
        expect(res.ok).toBe(true);
        expect(res.workspaceId).toBe('__system__');
        expect(sent[0].workspaceId).toBe('__system__');
        expect(sent[0].root).toBe(path.dirname(loose));
        expect(sent[0].relPath).toBe('notes.md');
    });

    it('a missing file names the FULLY resolved path and never dispatches', async () => {
        const res = await openFileForUserForMcp('term-a', { path: '.ai/plans/missing.md' });
        expect(res.ok).toBe(false);
        expect(res.error).toContain(path.join(wsA, '.ai', 'plans', 'missing.md'));
        // The confusing report was root + BASENAME — it must not appear.
        expect(res.error).not.toContain(path.join(wsA, 'missing.md'));
        // …and it must say what a relative path was resolved against.
        expect(res.error).toContain(wsA);
        expect(sent).toHaveLength(0);
    });

    it('a System terminal still opens an absolute path', async () => {
        const file = path.join(wsB, '.ai', 'plans', 'civic-commons-curriculum.md');
        const res = await openFileForUserForMcp('term-sys', { path: file });
        expect(res.ok).toBe(true);
        expect(res.workspaceId).toBe('__system__');
        expect(sent[0].root).toBe(path.dirname(file));
        expect(sent[0].relPath).toBe('civic-commons-curriculum.md');
    });

    it('an unattached terminal cannot open anything', async () => {
        const res = await openFileForUserForMcp('term-nope', { path: 'x.md' });
        expect(res.ok).toBe(false);
        expect(sent).toHaveLength(0);
    });
});
