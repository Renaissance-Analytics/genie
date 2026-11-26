import type { DeckItem } from '../core/deck.js';
import type { DisplayPost } from '../core/artboard.js';
import type { CallContext } from '../core/remote-protocol.js';
import { existingFiles, readQuestionFile, type QuestionFile } from './question-files.js';
import { readQuestionVisuals } from './question-visuals.js';

/**
 * A QUESTION'S FILES AND VISUALS, READ BY GENIE-HOST (Tynn #912, client/host split step 2f-1). The ForceTheQuestion
 * window's drawer (Genie 1's, the owner 2026-10-19) and its ArtBoard gallery (Tynn #835) were read from the disk by main;
 * they are the host's now, for every client, over `questions.files` / `questions.file` / `questions.visuals`.
 *
 * The question is looked up in the HOST'S OWN Deck by its id — never taken from the caller — and its files are read from
 * ITS workspace only, confined there (question-files.ts). A guest of one workspace is told nothing of another's question:
 * the same answer as a question this host does not hold.
 */
export interface HostQuestionReads {
    files(id: string, paths: readonly string[], context?: CallContext): Promise<string[] | null>;
    file(id: string, path: string, context?: CallContext): Promise<QuestionFile>;
    visuals(id: string, context?: CallContext): Promise<{ ok: true; posts: DisplayPost[] } | { ok: false; reason: string }>;
}

/** The drawer looks at no more named files than this (as the window did). */
const MAX_NAMED = 16;
const NO_WORKSPACE = 'Genie does not know this question’s workspace';
const NO_QUESTION = 'Genie does not know this question';

export function hostQuestionReads(ports: { deck: () => readonly DeckItem[]; workspacePath: (workspaceId: string) => string | null }): HostQuestionReads {
    /** The host's own question with this id, if the caller may see it. */
    const questionOf = (id: string, context: CallContext | undefined): DeckItem | null => {
        const item = ports.deck().find((i) => i.id === id && i.source === 'agent-question' && i.answer.kind === 'form') ?? null;
        if (!item) return null;
        // A guest of one workspace sees that workspace's questions only; the owner, this machine's windows and a guest of
        // the whole host see every one.
        if (context && !context.isOwner && context.workspaceId !== null && item.workspaceId !== context.workspaceId) return null;
        return item;
    };
    const rootOf = (item: DeckItem | null): string | null => (item?.workspaceId ? ports.workspacePath(item.workspaceId) : null);
    return {
        files: async (id, paths, context) => {
            const root = rootOf(questionOf(id, context));
            if (root === null) return null;
            return [...(await existingFiles(root, paths.filter((p): p is string => typeof p === 'string').slice(0, MAX_NAMED)))];
        },
        file: async (id, path, context) => {
            const root = rootOf(questionOf(id, context));
            if (root === null) return { ok: false, reason: NO_WORKSPACE };
            return readQuestionFile(root, path);
        },
        visuals: async (id, context) => {
            const item = questionOf(id, context);
            if (!item) return { ok: false, reason: NO_QUESTION };
            const root = rootOf(item);
            if (root === null) return { ok: false, reason: NO_WORKSPACE };
            try {
                return { ok: true, posts: (await readQuestionVisuals(root, item.answer.kind === 'form' ? item.answer.questions ?? [] : [])).posts };
            } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
