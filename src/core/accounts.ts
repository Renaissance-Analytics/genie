import type { AcpProvider } from './engine.js';

/** Provider-owned login material is deliberately not part of Genie's account book. */
export interface AccountIdentity {
    readonly name: string | null;
    readonly email: string | null;
    readonly plan: string | null;
}

export interface AccountRecord {
    readonly id: string;
    readonly provider: AcpProvider;
    readonly label: string;
    readonly labelEdited: boolean;
    readonly home: string;
    readonly legacy: boolean;
    readonly identity: AccountIdentity;
    readonly createdAt: string;
}

/** S4 supplies ONLY fields returned by the provider's own status command. */
export function accountLabel(email: string | null, ordinal: number): string {
    void email; void ordinal;
    return '';
}

export function legacyAccountId(provider: AcpProvider): string {
    void provider;
    return '';
}
