import type { Question } from '../core/attention.js';

/** STUB (RED): inert. */
export async function prepareQuestionVisuals(_caller: { agentId: string; agentName: string; workspaceId: string; workspacePath: string }, raw: readonly unknown[], _now: () => string): Promise<{ ok: true; questions: Question[] } | { ok: false; reason: string }> {
    return { ok: true, questions: raw as Question[] };
}

/** STUB (RED): inert. */
export async function recordQuestionOnBoard(_root: string, _record: { questionId: string; outcome: 'answered' | 'dismissed'; questions: readonly Question[]; selections: readonly (readonly string[])[] }, _at: string): Promise<void> {}
