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
    /** Legacy launches inherit the parent home variables, including their absence. */
    readonly legacy: boolean;
    readonly identity: AccountIdentity;
    readonly createdAt: string;
}

/**
 * The home a provider runs in. R2 (Tynn #753): ONE home per provider, the provider's own normal one, never an environment of
 * Genie's making; this describes an account, it is not a launch input.
 */
export type ProviderAccountHome = Pick<AccountRecord, 'provider' | 'home' | 'legacy'>;

/** S4 supplies ONLY fields returned by the provider's own status command. */
export function accountLabel(email: string | null, ordinal: number): string {
    return email?.trim() || `Account ${ordinal}`;
}

export function legacyAccountId(provider: AcpProvider): string {
    return `account_legacy_${provider}`;
}

export function unknownAccountIdentity(): AccountIdentity { return { name: null, email: null, plan: null }; }

/** Narrow the metadata API as well as disk data; never retain fields outside this model. */
export function accountIdentityOf(value: unknown): AccountIdentity {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid account identity');
    const data = value as Record<string, unknown>;
    const field = (key: string): string | null => {
        const v = data[key];
        if (v === null) return null;
        if (typeof v !== 'string' || !v.trim() || v.length > 512 || /[\x00-\x1f\x7f]/.test(v)) throw new Error('Invalid account identity field');
        return v.trim();
    };
    return { name: field('name'), email: field('email'), plan: field('plan') };
}

export function accountLabelOf(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid account label');
    return value.trim();
}
