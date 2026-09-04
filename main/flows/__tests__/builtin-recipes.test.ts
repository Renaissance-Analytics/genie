/**
 * The one piece of this feature that actually moves a user's files.
 *
 * `reference-case.test.ts` drives it through the whole stack; this exercises the
 * branches that stack cannot reach on demand — a file deleted between the event
 * and the run, a path escaping the workspace, the default destination. They are
 * the branches most likely to be met at 3am with nobody watching, which is
 * exactly the wrong time to discover one of them throws.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_RELOCATION_DIR,
    RELOCATION_DIR_ARG,
    relocateFileRecipe,
} from '../builtin-recipes';
import { runFlowTasks } from '../recipe';
import type { FlowDeclaredEffect, FlowRunContext } from '../types';

const roots: string[] = [];

function tempWorkspace(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-relocate-')));
    roots.push(root);
    return root;
}

function context(values: Record<string, unknown>) {
    const data = new Map(Object.entries(values));
    const declared: FlowDeclaredEffect[] = [];
    const ctx: FlowRunContext = {
        get: (k) => data.get(k),
        set: (k, v) => void data.set(k, v),
        declareEffect: (e) => void declared.push(e),
        emit: async () => {},
        flowId: 'w',
        runId: 'run-1',
    };
    return { ctx, declared, data };
}

const run = (ctx: FlowRunContext) => runFlowTasks(relocateFileRecipe, ctx);

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('relocating a file', () => {
    it('uses the default folder when the Flow does not name one', async () => {
        const root = tempWorkspace();
        fs.writeFileSync(path.join(root, 'big.bin'), 'x');
        const { ctx } = context({ workspacePath: root, relPath: 'big.bin' });

        await run(ctx);

        expect(fs.existsSync(path.join(root, DEFAULT_RELOCATION_DIR, 'big.bin'))).toBe(true);
        expect(ctx.get('relocated')).toBe(true);
    });

    it('declares the destination BEFORE it writes anything', async () => {
        // The ordering is load-bearing, not stylistic: the gap between writing
        // and declaring is exactly the window in which the Flow retriggers
        // itself. Asserted by declaring on a context that FAILS the write, so
        // the declaration cannot have come after it.
        const root = tempWorkspace();
        fs.writeFileSync(path.join(root, 'big.bin'), 'x');
        const { ctx, declared } = context({
            workspacePath: root,
            relPath: 'big.bin',
            [RELOCATION_DIR_ARG]: 'moved',
        });

        await run(ctx);

        expect(declared.map((d) => d.match.path)).toContain(path.join(root, 'moved', 'big.bin'));
        expect(declared.map((d) => d.match.path)).toContain(
            path.join(root, 'moved', '.gitignore'),
        );
    });

    it('does nothing when the file was gone by the time it ran', async () => {
        // Ordinary on a busy machine — the user deleted it, or another tool moved
        // it. Not a failure of anything, and not worth an error.
        const root = tempWorkspace();
        const { ctx } = context({
            workspacePath: root,
            relPath: 'vanished.bin',
            [RELOCATION_DIR_ARG]: 'moved',
        });

        await expect(run(ctx)).resolves.toBeUndefined();
        expect(ctx.get('relocated')).toBe(false);
        expect(String(ctx.get('relocatedReason'))).toContain('gone');
    });

    it('does nothing when the file is already in the destination', async () => {
        const root = tempWorkspace();
        fs.mkdirSync(path.join(root, 'moved'), { recursive: true });
        fs.writeFileSync(path.join(root, 'moved', 'big.bin'), 'x');
        const { ctx, declared } = context({
            workspacePath: root,
            relPath: 'moved/big.bin',
            [RELOCATION_DIR_ARG]: 'moved',
        });

        await run(ctx);

        expect(ctx.get('relocated')).toBe(false);
        expect(fs.existsSync(path.join(root, 'moved', 'big.bin'))).toBe(true);
        expect(declared, 'nothing was written, so nothing was declared').toEqual([]);
    });

    it('refuses a source that escapes the workspace', async () => {
        const root = tempWorkspace();
        const { ctx } = context({
            workspacePath: root,
            relPath: '../../etc/hosts',
            [RELOCATION_DIR_ARG]: 'moved',
        });
        await expect(run(ctx)).rejects.toThrow(/outside the workspace/);
    });

    it('refuses a destination that escapes the workspace', async () => {
        const root = tempWorkspace();
        fs.writeFileSync(path.join(root, 'big.bin'), 'x');
        const { ctx } = context({
            workspacePath: root,
            relPath: 'big.bin',
            [RELOCATION_DIR_ARG]: '../elsewhere',
        });

        await expect(run(ctx)).rejects.toThrow(/outside the workspace/);
        expect(fs.existsSync(path.join(root, 'big.bin')), 'the file was not moved').toBe(true);
    });

    it('refuses a run that was not given a file to act on', async () => {
        const { ctx } = context({ workspacePath: tempWorkspace() });
        await expect(run(ctx)).rejects.toThrow(/relPath/);
    });

    it('keeps both files when a name is already taken, numbering before the extension', async () => {
        const root = tempWorkspace();
        fs.mkdirSync(path.join(root, 'moved'), { recursive: true });
        fs.writeFileSync(path.join(root, 'moved', 'clip.mp4'), 'first');
        fs.writeFileSync(path.join(root, 'clip.mp4'), 'second');
        const { ctx } = context({
            workspacePath: root,
            relPath: 'clip.mp4',
            [RELOCATION_DIR_ARG]: 'moved',
        });

        await run(ctx);

        expect(fs.readFileSync(path.join(root, 'moved', 'clip.mp4'), 'utf8')).toBe('first');
        expect(fs.readFileSync(path.join(root, 'moved', 'clip-1.mp4'), 'utf8')).toBe('second');
    });

    it('does not rewrite a .gitignore that is already there', async () => {
        const root = tempWorkspace();
        fs.mkdirSync(path.join(root, 'moved'), { recursive: true });
        fs.writeFileSync(path.join(root, 'moved', '.gitignore'), 'mine\n');
        fs.writeFileSync(path.join(root, 'big.bin'), 'x');
        const { ctx } = context({
            workspacePath: root,
            relPath: 'big.bin',
            [RELOCATION_DIR_ARG]: 'moved',
        });

        await run(ctx);

        expect(fs.readFileSync(path.join(root, 'moved', '.gitignore'), 'utf8')).toBe('mine\n');
    });
});
