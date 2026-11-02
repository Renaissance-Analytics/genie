import type { Keychain, KeychainRead, KeychainResult } from './keychain.js';

export interface DeviceTokens {
    tokenFor(url: string): Promise<KeychainRead>;
    remember(url: string, token: string): Promise<KeychainResult>;
    forget(url: string): Promise<KeychainResult>;
    hosts(): string[];
}

export function deviceTokenStore(_file: string, _keychain: Pick<Keychain, 'get' | 'set' | 'delete'>): DeviceTokens {
    throw new Error('not built yet');
}
