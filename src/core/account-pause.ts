/**
 * A PAUSED ACCOUNT (the owner, 2026-10-21: "you may have just experienced an account pause due to a payment failure on my
 * subscription. we need to be able to capture those and alert the user").
 *
 * MEASURED that night: prism's Claude turn failed with `oauth_org_not_allowed` — "Your organization has disabled Claude
 * subscription access for Claude Code". prism-acp's `TurnFailure` names it `auth`; it names `billing_error`,
 * `account_on_hold` and `verification_required` `billing`. None of these is the agent's fault, and none is fixed by
 * logging in: the ACCOUNT has to be put right where the provider bills it. So they are their own state, said in words.
 */

export interface AccountPause {
    /** The provider's own reason, verbatim. */
    readonly reason: string;
    /** What it means, for a person. */
    readonly words: string;
}

const WORDS: Readonly<Record<string, string>> = {
    billing_error: 'the provider reported a billing problem with this subscription',
    account_on_hold: 'the account is on hold',
    verification_required: 'the account needs to be verified',
    oauth_org_not_allowed: 'subscription access is disabled for this account',
};

/** The paused account a failed turn reports, or `null` when the failure is anything else. */
export function accountPauseOf(failure: { readonly kind: string; readonly reason: string } | null | undefined): AccountPause | null {
    if (!failure) return null;
    const words = WORDS[failure.reason];
    if (words) return { reason: failure.reason, words };
    // A billing failure prism-acp knows and this list does not: still a paused account, in the provider's own word.
    if (failure.kind === 'billing') return { reason: failure.reason, words: `the provider refused this account (${failure.reason})` };
    return null;
}

/**
 * ONE ALERT PER LOGIN. Every agent on a paused account stops together; the person is told once, not once per agent, and
 * again only if the account pauses again after it was cleared.
 */
export class PauseAlerts {
    #paused = new Set<string>();

    /** The logins paused now; answers the ones newly paused, which are the ones to alert. */
    update(paused: readonly string[]): string[] {
        const now = new Set(paused);
        const fresh = [...now].filter((p) => !this.#paused.has(p));
        this.#paused = now;
        return fresh;
    }
}
