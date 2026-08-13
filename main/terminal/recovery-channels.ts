/**
 * IPC channels for host-loss recovery (genie#203, Fix C). Single source of truth
 * so the channel strings cannot drift between the main-side broadcast
 * (genie-adapter) and the preload listener — a rename on one side without the
 * other silently breaks recovery, and typecheck can't see a bare-literal mismatch.
 *
 * Pure constants (no electron/node), so preload's isolated context can import
 * them just like main does.
 */

export type RecoveryState = 'recovering' | 'recovered' | 'degraded';

/** Main → renderer: remount these terminals so their `terminal:create` rejoins
 *  the respawned host and replays scrollback. */
export const TERMINAL_RECOVER_CHANNEL = 'terminal:recover';

/** Main → renderer: recovery status for the banner ('recovering' → 'recovered' |
 *  'degraded'). */
export const TERMINAL_RECOVERY_STATUS_CHANNEL = 'terminal:recovery-status';

export interface TerminalRecoverPayload {
    ids: string[];
}

export interface TerminalRecoveryStatusPayload {
    state: RecoveryState;
}
