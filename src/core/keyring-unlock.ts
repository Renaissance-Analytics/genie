/**
 * GENIE ASKS TO UNLOCK THE KEYRING ITSELF — THE PLAN (Tynn story #388; the owner: "I need genie to request unlocking the
 * keyring when it starts on linux. don't make a user understand how to do that").
 *
 * The Secret Service's own two-step unlock (freedesktop.org Secret Service API): `Service.Unlock([default collection])`
 * answers what it unlocked at once and a prompt object; a prompt other than `/` is shown with `Prompt.Prompt('')` and
 * ends with its `Completed(dismissed, result)` signal. The DESKTOP draws the dialog: Genie never asks for or sees the
 * password. Pure: the transport is main/secret-service-bus.ts.
 */

export const SECRET_SERVICE = 'org.freedesktop.secrets';
export const SECRET_SERVICE_PATH = '/org/freedesktop/secrets';
export const DEFAULT_COLLECTION = '/org/freedesktop/secrets/aliases/default';
/** The prompt path that means "nothing to prompt": the call already did what it could. */
export const NO_PROMPT = '/';

export interface BusCall {
    readonly path: string;
    readonly iface: string;
    readonly member: string;
    readonly args: readonly unknown[];
}
export interface BusWait {
    readonly path: string;
    readonly iface: string;
    readonly member: string;
}

/** The first call: unlock the default collection. */
export function unlockCall(): BusCall {
    return { path: SECRET_SERVICE_PATH, iface: 'org.freedesktop.Secret.Service', member: 'Unlock', args: [[DEFAULT_COLLECTION]] };
}

/** After Unlock answered: done (nothing to prompt), or the prompt to show and the signal to wait for. */
export function afterUnlockReply(reply: { unlocked: readonly string[]; prompt: string }): { done: 'unlocked' } | { prompt: BusCall; wait: BusWait } {
    if (reply.prompt === NO_PROMPT || reply.prompt === '') return { done: 'unlocked' };
    return {
        prompt: { path: reply.prompt, iface: 'org.freedesktop.Secret.Prompt', member: 'Prompt', args: [''] },
        wait: { path: reply.prompt, iface: 'org.freedesktop.Secret.Prompt', member: 'Completed' },
    };
}

export type UnlockOutcome = 'unlocked' | 'dismissed' | 'failed' | 'cancelled';

/** How an unlock ended. */
export function unlockOutcome(e: { kind: 'completed'; dismissed: boolean } | { kind: 'done' } | { kind: 'error'; message: string } | { kind: 'cancelled' }): UnlockOutcome {
    switch (e.kind) {
        case 'completed': return e.dismissed ? 'dismissed' : 'unlocked';
        case 'done': return 'unlocked';
        case 'cancelled': return 'cancelled';
        default: return 'failed';
    }
}

/** The card's words — never manual steps (the owner: "don't make a user understand how to do that"). */
export const UNLOCK_WORDS = {
    asking: 'Genie is asking to unlock your keyring',
    stillLocked: 'Your keyring is still locked',
    failed: 'Genie could not ask your keyring to unlock',
    button: 'Unlock',
} as const;
