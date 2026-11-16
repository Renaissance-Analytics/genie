import type { AccountsSnapshot } from '../../core/accounts-view.js';
import type { AccountsAction, AccountsActResult } from '../../core/account-settings.js';

/** ACCOUNTS S11 (Tynn #484): RED stub. */
export interface AccountsSettingsProps {
    readonly snapshot: AccountsSnapshot | undefined;
    readonly offerWindows: unknown;
    readonly onSetOfferWindows: (value: string) => void;
    readonly onSwitch?: ((provider: string, choose?: string) => void) | undefined;
    readonly onAct?: ((action: AccountsAction) => Promise<AccountsActResult>) | undefined;
    readonly now?: number | undefined;
}

export function AccountsSettings(_props: AccountsSettingsProps) {
    return null;
}
