import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileAddedEvent, ignoredPath, matchesFileTrigger, planFileMove, shellTemplatesInFileFlow } from '../src/core/file-trigger.js';

/**
 * A FILE ADDED TO A WORKSPACE STARTS A FLOW (genie#1204 item 5 — Genie 1's `files:added`, main/flows/file-source.ts).
 * The owner's reference case: "a file added anywhere in a workspace, and if it is over 5 MB it gets moved into an
 * untracked folder so the repo does not get heavy" — an event, a prop (size), a filter (> 5 MB), an action (move).
 * These are the pure decisions: what an addition is, which trigger it matches, where a move lands, and what is refused.
 */

// A workspace root is ABSOLUTE, drive and all on Windows (main CI 40319133769: join('/', …) has no drive there, and
// the planner — rightly — resolves one, so the two never compared equal).
const ROOT = resolve('/', 'work', 'tynn');

describe('what an addition is (fs.watch reports `rename` when a path appears, `change` when content is written)', () => {
    const input = { workspaceId: 'tynn', workspacePath: ROOT, relPath: 'uploads/Photo.JPG', eventType: 'rename' as const, stat: { isFile: true, size: 6_000_000 } };

    it('a rename to a path that is now a file is an addition, with every prop a flow can use', () => {
        expect(fileAddedEvent(input)).toEqual({
            workspaceId: 'tynn',
            path: join(ROOT, 'uploads/Photo.JPG'),
            relPath: 'uploads/Photo.JPG',
            name: 'Photo.JPG',
            extension: 'jpg',
            sizeBytes: 6_000_000,
        });
    });

    it('a content change, a delete and a directory are not additions', () => {
        expect(fileAddedEvent({ ...input, eventType: 'change' })).toBeNull();
        expect(fileAddedEvent({ ...input, stat: null })).toBeNull();
        expect(fileAddedEvent({ ...input, stat: { isFile: false, size: 0 } })).toBeNull();
    });

    it('a leading dot is not an extension; a name without a dot has none', () => {
        expect(fileAddedEvent({ ...input, relPath: '.gitignore' })?.extension).toBe('');
        expect(fileAddedEvent({ ...input, relPath: 'bin/Makefile' })?.extension).toBe('');
        expect(fileAddedEvent({ ...input, relPath: 'a/b.tar.GZ' })?.extension).toBe('gz');
    });
});

describe('which paths are never watched for a trigger', () => {
    it('.git, node_modules and vendor — anywhere in the path — are ignored (CONTROL: a look-alike name is not)', () => {
        for (const p of ['.git/index', 'node_modules/x/y.js', 'app/node_modules/z.js', 'vendor/autoload.php', 'packages/a/vendor/b.php']) expect(ignoredPath(p), p).toBe(true);
        for (const p of ['src/vendors.ts', 'docs/git-guide.md', 'node_modules_backup.txt', 'uploads/a.png']) expect(ignoredPath(p), p).toBe(false);
    });
});

describe('which trigger an addition matches', () => {
    const event = { workspaceId: 'tynn', path: join(ROOT, 'uploads/big.png'), relPath: 'uploads/big.png', name: 'big.png', extension: 'png', sizeBytes: 6_000_000 };

    it('no filters: every addition in the workspace', () => {
        expect(matchesFileTrigger({ workspace: 'tynn' }, event)).toBe(true);
    });

    it('another workspace never matches', () => {
        expect(matchesFileTrigger({ workspace: 'moic' }, event)).toBe(false);
    });

    it('a folder matches what is in it, at any depth — not a folder that only starts the same', () => {
        expect(matchesFileTrigger({ workspace: 'tynn', folder: 'uploads' }, event)).toBe(true);
        expect(matchesFileTrigger({ workspace: 'tynn', folder: './uploads/' }, event)).toBe(true);
        expect(matchesFileTrigger({ workspace: 'tynn', folder: 'up' }, event)).toBe(false);
        expect(matchesFileTrigger({ workspace: 'tynn', folder: 'uploads' }, { ...event, relPath: 'uploads/2026/big.png' })).toBe(true);
        expect(matchesFileTrigger({ workspace: 'tynn', folder: 'uploads' }, { ...event, relPath: 'uploads-old/big.png' })).toBe(false);
    });

    it('extensions: any of them, case and dot ignored', () => {
        expect(matchesFileTrigger({ workspace: 'tynn', extensions: 'jpg, .PNG' }, event)).toBe(true);
        expect(matchesFileTrigger({ workspace: 'tynn', extensions: 'jpg,gif' }, event)).toBe(false);
        expect(matchesFileTrigger({ workspace: 'tynn', extensions: ' ' }, event)).toBe(true);
    });

    it('a minimum size is inclusive (the owner\'s "over 5 MB": 5 MB and up)', () => {
        expect(matchesFileTrigger({ workspace: 'tynn', minSizeBytes: 5_000_000 }, event)).toBe(true);
        expect(matchesFileTrigger({ workspace: 'tynn', minSizeBytes: 6_000_000 }, event)).toBe(true);
        expect(matchesFileTrigger({ workspace: 'tynn', minSizeBytes: 6_000_001 }, event)).toBe(false);
    });
});

describe('where a move lands (genie/file_move: no shell, inside the workspace, never overwriting)', () => {
    const none = () => false;

    it('into the folder, keeping the name', () => {
        expect(planFileMove(ROOT, join(ROOT, 'uploads/big.png'), '.untracked', none)).toEqual({ ok: true, dest: join(ROOT, '.untracked/big.png') });
    });

    it('a name already there gets " (2)", then " (3)" — nothing is overwritten', () => {
        const taken = new Set([join(ROOT, '.untracked/big.png'), join(ROOT, '.untracked/big (2).png')]);
        expect(planFileMove(ROOT, join(ROOT, 'uploads/big.png'), '.untracked', (p) => taken.has(p))).toEqual({ ok: true, dest: join(ROOT, '.untracked/big (3).png') });
    });

    it('a file already in that folder is left where it is (the move\'s own arrival must not move it again)', () => {
        expect(planFileMove(ROOT, join(ROOT, '.untracked/big.png'), '.untracked', none)).toEqual({ ok: true, dest: null });
    });

    it('a source or a destination outside the workspace is refused, in words', () => {
        const outside = planFileMove(ROOT, resolve('/', 'etc', 'passwd'), '.untracked', none);
        expect(outside.ok).toBe(false);
        expect(outside.ok ? '' : outside.reason).toMatch(/outside the workspace/);
        const escape = planFileMove(ROOT, join(ROOT, 'uploads/big.png'), '../elsewhere', none);
        expect(escape.ok).toBe(false);
        expect(escape.ok ? '' : escape.reason).toMatch(/outside the workspace/);
    });
});

describe('a file name never reaches a shell', () => {
    const graph = (command: string, trigger = 'genie/file_added') => ({
        nodes: [
            { id: 't', kind: trigger, config: { workspace: 'tynn' } },
            { id: 's', kind: 'genie/terminal_run', config: { workspace: 'tynn', command } },
        ],
    });

    it('a command step that templates a value, in a flow a file starts, is named — a file name can carry $(…) or ;', () => {
        expect(shellTemplatesInFileFlow(graph('mv "{{in.path}}" .untracked/'))).toEqual(['s']);
        expect(shellTemplatesInFileFlow(graph('echo {{ in.name }}'))).toEqual(['s']);
    });

    it('CONTROL: a command with no template, or a templated command in a SCHEDULED flow, is not', () => {
        expect(shellTemplatesInFileFlow(graph('git status'))).toEqual([]);
        expect(shellTemplatesInFileFlow(graph('echo {{in.firedAt}}', 'schedule_trigger'))).toEqual([]);
    });
});
