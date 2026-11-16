import type { AccountSwitchOutcome, SwitchAccountRef } from '../core/account-switch.js';
import { accountSwitchSteps, providerLogin } from '../core/provider-login.js';

/**
 * SWITCHING A PROVIDER'S ACCOUNT (Tynn #753; Accounts R2). The owner switches by signing in again with the provider's own
 * login in its normal home, and his agents keep going because their session files live in that one home. So a switch is just
 * that: Genie opens the provider's own login in a terminal, in that same home, with the steps on screen. It never handles a
 * credential, and it does not stop, start or message an agent: they keep their threads.
 *
 * Which account is signed in afterwards is READ, not chosen: the identity read after the login (`AccountIdentityReader`) sets
 * the book's active account by email, and usage is attributed to it from then on.
 */

/** What opening the provider's own login to switch accounts needs. */
export interface AccountSwitchLoginPorts {
    readonly login: { startSwitch(provider: string): { ok: true; terminalId: string } | { ok: false; reason: string } };
}

export type AccountSwitchStart =
    | { ok: true; terminalId: string; instructions: readonly string[] }
    | { ok: false; reason: string };

/** Open the provider's own login in its one home; the answer carries the steps the window shows. */
export function startAccountSwitch(ports: AccountSwitchLoginPorts, provider: string): AccountSwitchStart {
    if (!providerLogin(provider)) return { ok: false, reason: `Genie has no account switch for the provider "${provider}"; sign in with its own tools.` };
    const started = ports.login.startSwitch(provider);
    if (!started.ok) return started;
    return { ok: true, terminalId: started.terminalId, instructions: accountSwitchSteps(provider) };
}

/** RED stub (Tynn #482). */
export interface AccountSwitchFlowPorts extends AccountSwitchLoginPorts {
    readonly active: (provider: string) => SwitchAccountRef;
    readonly readIdentity: (provider: string) => Promise<void>;
    readonly emit: (outcome: AccountSwitchOutcome) => void;
}

export class AccountSwitchFlow {
    readonly #p: AccountSwitchFlowPorts;
    constructor(ports: AccountSwitchFlowPorts) { this.#p = ports; }
    start(provider: string): AccountSwitchStart | { ok: true; terminalId: string } { return this.#p.login.startSwitch(provider); }
    async settle(_provider: string, _signedIn: boolean): Promise<AccountSwitchOutcome | null> { return null; }
}
