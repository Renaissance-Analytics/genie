/**
 * A PROVIDER'S OWN LOGIN (the owner, 2026-10-18: "provider login issues … with a button to help resolve it").
 *
 * Each command is the CLI's documented one, never a guess at what its TUI accepts:
 *  - Claude Code — `claude auth login` signs in; `claude auth status` exits 0 when signed in, 1 when not
 *    (code.claude.com/docs/en/cli-reference).
 *  - Codex — `codex login` signs in (a browser, or device auth); `codex login status` exits 0 when signed in
 *    (the Codex CLI reference).
 *
 * A provider not here has no login Genie knows: its own CLI opens in the login window, and the window's notice says what
 * to do by hand (renderer `TakeOverWindow`).
 */
export interface ProviderLogin {
    /** The provider as a person reads it. */
    readonly name: string;
    /** The command that signs in, run in a terminal the person can answer. */
    readonly login: string;
    /** The command that says whether it worked: exit 0 = signed in. */
    readonly status: string;
}

const LOGINS: Readonly<Record<string, ProviderLogin>> = {
    claude: { name: 'Claude Code', login: 'claude auth login', status: 'claude auth status' },
    codex: { name: 'Codex', login: 'codex login', status: 'codex login status' },
};

export function providerLogin(provider: string): ProviderLogin | null {
    return LOGINS[provider] ?? null;
}

/** The fields of a status's JSON that say WHICH account is signed in (an email, an account or organisation id). */
const ACCOUNT_FIELD = /email|account|org/i;

/**
 * WHICH ACCOUNT IS SIGNED IN, from what the status command prints (Tynn #699: a limit belongs to the account, so a switch
 * releases the agents held on it). `claude auth status` prints JSON; its account fields — any key naming an email, an account
 * or an organisation — make the identity, in key order. Nothing to tell an account by (text, as Codex prints, or JSON with
 * no such field) is `null`: never a change.
 */
export function accountIdentityFrom(stdout: string): string | null {
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { return null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const parts = Object.entries(parsed as Record<string, unknown>)
        .filter(([key, value]) => ACCOUNT_FIELD.test(key) && (typeof value === 'string' || typeof value === 'number') && String(value) !== '')
        .map(([key, value]) => `${key}=${String(value)}`)
        .sort();
    return parts.length > 0 ? parts.join(';') : null;
}

/** What the agent is told once its provider is signed in again and it has been brought back. */
export const SIGNED_IN_AGAIN =
    'You were signed out of your provider, and the login is back. Carry on with what you were doing: the last message to you may not have reached you, so read the conversation above before you act.';

/** What each agent is told when the person says its paused ACCOUNT is put right (`Try again`, core/account-pause.ts). */
export const ACCOUNT_BACK =
    'Your provider had paused this account, and the person says it is put right. Carry on with what you were doing: the last message to you may not have reached you, so read the conversation above before you act.';

/**
 * WHAT THE PERSON DOES TO SWITCH ACCOUNTS (Tynn #753). Every account of a provider signs in to the provider's ONE normal home,
 * the one the person's agents already use, so their conversations carry on. The steps are the provider's own; Genie runs its
 * CLI and shows these words, types nothing, and never sees a code or a token. Empty for a provider Genie has no switch for.
 */
export function accountSwitchSteps(provider: string): readonly string[] {
    const closing = 'When it says you are signed in, close this window. Genie then reads which account is signed in; your agents are not stopped and keep their conversations.';
    if (provider === 'claude') {
        return [
            'Genie has opened Claude Code in the terminal below, in the same place your agents already use.',
            'Type /logout and press Enter.',
            'Then type /login and press Enter, and choose the other account. A browser may open: sign in there, then come back to this window.',
            closing,
        ];
    }
    if (provider === 'codex') {
        return [
            'Genie is running codex logout and then codex login in the terminal below, in the same place your agents already use.',
            'Follow codex login: choose the other account. A browser may open: sign in there, then come back to this window.',
            'If it stops after codex logout, type codex login and press Enter.',
            closing,
        ];
    }
    return [];
}
