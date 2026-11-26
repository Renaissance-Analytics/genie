/**
 * WHAT A GATED TOOL TELLS THE AGENT WHEN IT DID NOT GO AHEAD (Tynn #1006). The person said no, or nobody answered within
 * the approval's 30 minutes and it expired: two different things, said in plain words, each with what was left undone.
 */
export function refusalWords(verdict: 'denied' | 'expired', what: string, undone: string): string {
    return verdict === 'expired'
        ? `${what} was not approved in time: nobody answered within 30 minutes, so the request expired; ${undone}`
        : `${what} was denied by the person; ${undone}`;
}
