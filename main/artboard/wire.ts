import fs from 'node:fs';
import path from 'node:path';
import { BOARD_DIR, BOARD_INDEX, parseBoard, type BoardPost } from './board';
import { resolveBoard, type ResolvedBoard } from './resolve';
import { reviewPost, type ReviewResult } from './host';

/**
 * ArtBoard's concrete wiring — the real filesystem and the real delivery path,
 * kept apart from the decisions so those stay testable without a disk.
 *
 * Everything here resolves inside `<workspaceRoot>/.artboard/`, and every read
 * uses a post's BARE FILENAME (the parser refuses anything else). Both halves
 * matter: the parser stops a hostile index, and joining against a fixed
 * directory stops a bug here from becoming one.
 */

export interface WireDeps {
    /** Absolute path of the workspace, or null when it is unknown. */
    workspaceRoot: (workspaceId: string) => string | null;
    /** Deliver a message from the human to the agent on a terminal. */
    deliver: (terminalId: string, text: string) => boolean;
}

function boardDir(root: string): string {
    return path.join(root, BOARD_DIR);
}

/** Read the stored board. An absent or unreadable index is an EMPTY board, never
 *  an error: a workspace no agent has posted to is the normal case. */
function readStored(root: string): BoardPost[] {
    try {
        return parseBoard(fs.readFileSync(path.join(boardDir(root), BOARD_INDEX), 'utf8'));
    } catch {
        return [];
    }
}

function writeStored(root: string, board: BoardPost[]): void {
    const dir = boardDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BOARD_INDEX), JSON.stringify({ posts: board }, null, 2), 'utf8');
}

/** The board a PANEL shows: resolved to markup and data URLs, because the
 *  renderer cannot read the filesystem. */
export function readBoardForPanel(workspaceId: string, deps: WireDeps): ResolvedBoard {
    const root = deps.workspaceRoot(workspaceId);
    if (!root) {
        return { posts: [], error: 'That workspace is not open, so its board cannot be read.' };
    }
    const dir = boardDir(root);
    return resolveBoard(readStored(root), {
        readText: (file) => fs.readFileSync(path.join(dir, file), 'utf8'),
        readBase64: (file) => fs.readFileSync(path.join(dir, file)).toString('base64'),
    });
}

/** Record a verdict and tell the agent that posted it. */
export function reviewBoardPost(
    workspaceId: string,
    postId: string,
    review: { verdict: 'approved' | 'rejected'; comment?: string },
    deps: WireDeps,
): ReviewResult {
    const root = deps.workspaceRoot(workspaceId);
    if (!root) {
        return { ok: false, delivered: false, error: 'That workspace is not open.' };
    }
    return reviewPost(workspaceId, postId, review, {
        readBoard: () => readStored(root),
        writeBoard: (_ws, board) => writeStored(root, board),
        deliver: deps.deliver,
        now: () => new Date().toISOString(),
    });
}
