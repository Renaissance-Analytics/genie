import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { planFileMove } from '../core/file-trigger.js';
import type { FlowPorts } from './flow-executors.js';

/**
 * `genie/file_move`, for real (genie#1204 item 5): a file into a folder of the same workspace — no shell, the folder
 * created when missing, nothing ever overwritten (`name (2).ext`), nothing outside the workspace (core/file-trigger.ts
 * `planFileMove`). The destination is announced to the file source BEFORE the move (`expectArrival`), so the move's
 * own arrival is not a new addition — a "move big files to .untracked" flow must not chase its own tail.
 */
export interface FileMoverDeps {
    /** The workspace's folder, or null when it is not registered. */
    readonly workspacePath: (workspaceId: string) => string | null;
    readonly expectArrival: (absPath: string) => void;
}

export function fileMover(deps: FileMoverDeps): NonNullable<FlowPorts['moveFile']> {
    return async (workspaceId, from, toFolder) => {
        const root = deps.workspacePath(workspaceId);
        if (root === null) throw new Error(`workspace ${workspaceId} is not registered here; nothing was moved`);
        const plan = planFileMove(root, from, toFolder, existsSync);
        if (!plan.ok) throw new Error(plan.reason);
        // The file as the plan read it: inside the workspace. A name relative to the workspace (a manual flow's "File"
        // setting) is the workspace's file — never one relative to wherever Genie's own process happens to be.
        const source = resolve(root, from);
        if (plan.dest === null) return { from: source, to: null };
        if (!existsSync(source)) throw new Error(`${from} is no longer there; nothing was moved`);
        await mkdir(dirname(plan.dest), { recursive: true });
        deps.expectArrival(plan.dest);
        try {
            await rename(source, plan.dest);
        } catch (error) {
            // Another volume inside the workspace (a mount): copy, then remove the original — never the other way round.
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            await copyFile(source, plan.dest);
            await unlink(source);
        }
        return { from: source, to: plan.dest };
    };
}
