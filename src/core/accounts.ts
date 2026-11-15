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

/** Explicit launch semantics must travel with a home, including across the window's metadata projection. */
export type ProviderAccountHome = Pick<AccountRecord, 'provider' | 'home' | 'legacy'>;

/** Managed homes are explicit; legacy homes inherit. No credential I/O or mutation of the parent's env. */
export function providerAccountEnv(account: ProviderAccountHome, parentEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const { provider, home, legacy } = account;
    // Pure because the account model is also used by the renderer. Accept absolute POSIX, drive and UNC paths.
    if ((provider !== 'claude' && provider !== 'codex') || typeof legacy !== 'boolean' || typeof home !== 'string' || /[\x00-\x1f\x7f]/.test(home) ||
        !(home.startsWith('/') || /^[A-Za-z]:[\\/]/.test(home) || /^\\\\[^\\]+\\[^\\]+/.test(home))) throw new Error('Invalid provider account home');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parentEnv)) {
        if (value !== undefined && (legacy || !/^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(key))) env[key] = value;
    }
    // Explicit ~/.claude is NOT equivalent to unset: Claude changes its global config/keychain lookup.
    // Keep both providers' existing variable presence and values for a legacy launch.
    if (!legacy) env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = home;
    return env;
}

/** S4 supplies ONLY fields returned by the provider's own status command. */
export function accountLabel(email: string | null, ordinal: number): string {
    return email?.trim() || `Account ${ordinal}`;
}

export function legacyAccountId(provider: AcpProvider): string {
    return `account_legacy_${provider}`;
}

/** Managed ids carry no provider claim; the host book checks their provider when assigning one. */
export function accountIdIsValid(provider: AcpProvider, value: unknown): value is string {
    return typeof value === 'string' && (value === legacyAccountId(provider) || /^account_[0-9a-f]{32}$/.test(value));
}

export function accountThreadKey(provider: AcpProvider, accountId: string): string {
    return `${provider}:${accountId}`;
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
