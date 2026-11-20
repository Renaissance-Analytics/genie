/**
 * ANOTHER MACHINE'S QUESTION, BY ITS ID (Tynn #726; #912 2f-1). RemoteQuestions (main/remote-questions.ts) shows a connected
 * machine's live questions in this machine's question window under ids of its own: this prefix, the reporting window, and
 * the host's id. The question page answers such a question through the window driving that machine, never this host.
 */
export const REMOTE_QUESTION_PREFIX = 'remote:';

export function isRemoteQuestionId(id: string): boolean {
    throw new Error(`2f-1: not built yet (${id})`);
}
