import type { DeckItem } from '../core/deck.js';
import type { DisplayPost } from '../core/artboard.js';
import type { CallContext } from '../core/remote-protocol.js';
import type { QuestionFile } from './question-files.js';

export interface HostQuestionReads {
    files(id: string, paths: readonly string[], context?: CallContext): Promise<string[] | null>;
    file(id: string, path: string, context?: CallContext): Promise<QuestionFile>;
    visuals(id: string, context?: CallContext): Promise<{ ok: true; posts: DisplayPost[] } | { ok: false; reason: string }>;
}

export function hostQuestionReads(_ports: { deck: () => readonly DeckItem[]; workspacePath: (workspaceId: string) => string | null }): HostQuestionReads {
    throw new Error('2f-1: not built yet');
}
