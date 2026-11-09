/**
 * The words of a provider hidden behind a batch wrapper (Tynn #577), apart from how it is found: the window reads these,
 * and must not import `node:path`.
 */
export const PROVIDER_PROGRAM_PROBLEM = 'is a batch file Genie cannot run';

/** The provider a reason of that kind names, or `null` for any other reason: a chat's "Not sent" line has no provider of its own. */
export function providerOfProgramProblem(reason: string): string | null {
    return new RegExp(`(\\S+) on PATH ${PROVIDER_PROGRAM_PROBLEM}`).exec(reason)?.[1] ?? null;
}

/** Whether a reason is that problem: the settings offer the picker with it, and only with it. */
export function isProviderProgramProblem(reason: string): boolean {
    return reason.includes(PROVIDER_PROGRAM_PROBLEM);
}
