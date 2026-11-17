import { switchOutcome, type AccountSwitchOutcome, type SwitchAccountRef } from '../core/account-switch.js';
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

/**
 * THE GUIDED SWITCH (Tynn #482, Accounts S9). One click opens the provider's own login (above). When its terminal is over (it
 * exits, or the person closes its window, as the steps say to) the login host asks the provider's status and calls `settle`:
 * signed in, Genie reads who it is (S4's identity read, which sets the book's active account by email) and only then says
 * which account is active; signed out, nothing is read and the active account stays as it was. The outcome is told once, to
 * every window. Its ports are the login, the active account, the identity read and the notice: nothing here can reach an
 * agent, which keeps its thread whatever the outcome.
 */
export interface AccountSwitchFlowPorts extends AccountSwitchLoginPorts {
    /** The provider's active account in the book, now. */
    readonly active: (provider: string) => SwitchAccountRef;
    /** Ask the provider who is signed in, and record it in the book (S4). */
    readonly readIdentity: (provider: string) => Promise<void>;
    /** Tell every window how the switch came out. */
    readonly emit: (outcome: AccountSwitchOutcome) => void;
}

export class AccountSwitchFlow {
    readonly #p: AccountSwitchFlowPorts;
    /** The switches open now, by provider: the active account when each opened. */
    readonly #open = new Map<string, SwitchAccountRef>();

    constructor(ports: AccountSwitchFlowPorts) { this.#p = ports; }

    /** Open the switch (or bring back the one already open), remembering which account was active. */
    start(provider: string): AccountSwitchStart {
        const started = startAccountSwitch(this.#p, provider);
        if (started.ok && !this.#open.has(provider)) this.#open.set(provider, this.#p.active(provider));
        return started;
    }

    /** The switch's login is over: `signedIn` is the provider's status answer. `null` when no switch was open for it. */
    async settle(provider: string, signedIn: boolean): Promise<AccountSwitchOutcome | null> {
        const before = this.#open.get(provider);
        if (before === undefined) return null;
        this.#open.delete(provider);
        if (signedIn) await this.#p.readIdentity(provider).catch(() => undefined);
        const outcome = switchOutcome({ provider, before, after: signedIn ? this.#p.active(provider) : before, signedIn });
        this.#p.emit(outcome);
        return outcome;
    }
}
