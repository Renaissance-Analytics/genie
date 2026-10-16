/**
 * THE UPDATE STATUS LINE (the owner, 2026-10-13: "where even is the check for updates button?").
 * The header chip is silent until there is something to act on; Settings → General says where
 * things stand in every phase, beside the button that asks again. Pure: the clock that formats
 * `checkedAt` is passed in, so the line is the same in a test as in the window.
 */
export type UpdatePhase = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';

/** The fields of the renderer's `UpdateState` this line reads — core does not import from the renderer. */
export interface UpdateStatusInput {
    readonly phase: UpdatePhase;
    readonly version: string | null;
    readonly percent: number | null;
    readonly error: string | null;
    readonly checkedAt: number | null;
}

export function updateStatusLine(state: UpdateStatusInput | null, clock: (ms: number) => string): string {
    if (!state) return 'Not checked yet';
    const v = state.version ?? '';
    switch (state.phase) {
        case 'idle':
        case 'none':
            return state.checkedAt === null ? 'Not checked yet' : `Up to date — checked ${clock(state.checkedAt)}`;
        case 'checking':
            return 'Checking for updates…';
        case 'available':
            return `Genie ${v} is available`;
        case 'downloading':
            return `Downloading Genie ${v}${state.percent === null ? '' : ` ${Math.round(state.percent)}%`}`;
        case 'downloaded':
            return `Genie ${v} is ready — restart to install`;
        case 'installing':
            return `Installing Genie ${v}…`;
        case 'error':
            return `Could not check: ${state.error ?? 'unknown error'}`;
    }
}

/** A check can be asked for unless one is already running or an update is on its way in. */
export function canCheckNow(phase: UpdatePhase): boolean {
    return phase !== 'checking' && phase !== 'downloading' && phase !== 'installing';
}
