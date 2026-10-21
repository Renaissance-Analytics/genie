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

/** What the agent is told once its provider is signed in again and it has been brought back. */
export const SIGNED_IN_AGAIN =
    'You were signed out of your provider, and the login is back. Carry on with what you were doing: the last message to you may not have reached you, so read the conversation above before you act.';

/** What each agent is told when the person says its paused ACCOUNT is put right (`Try again`, core/account-pause.ts). */
export const ACCOUNT_BACK =
    'Your provider had paused this account, and the person says it is put right. Carry on with what you were doing: the last message to you may not have reached you, so read the conversation above before you act.';
