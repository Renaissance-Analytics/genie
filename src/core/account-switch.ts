/** ACCOUNTS S9 (Tynn #482): RED stub. */
export interface SwitchAccountRef { readonly id: string; readonly label: string }
export type AccountSwitchOutcome =
    | { readonly kind: 'switched'; readonly provider: string; readonly accountId: string; readonly label: string; readonly fromAccountId: string; readonly fromLabel: string }
    | { readonly kind: 'unchanged'; readonly provider: string; readonly accountId: string; readonly label: string }
    | { readonly kind: 'signed-out'; readonly provider: string; readonly accountId: string; readonly label: string };

export function switchOutcome(_input: { provider: string; before: SwitchAccountRef; after: SwitchAccountRef; signedIn: boolean }): AccountSwitchOutcome {
    return null as unknown as AccountSwitchOutcome;
}
export function accountSwitchWords(_o: AccountSwitchOutcome): { title: string; body: string; retry: boolean } {
    return { title: '', body: '', retry: false };
}
export function accountSwitchToast(_o: AccountSwitchOutcome, _again: (provider: string) => void): { title: string; body: string; action?: { label: string; run: () => void } } {
    return { title: '', body: '' };
}
