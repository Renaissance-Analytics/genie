// RED STUB (TDD): test/os-cipher.test.ts describes this module; the implementation follows.
export interface SafeStorageLike { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string; encryptString(text: string): Buffer; decryptString(bytes: Buffer): string }
export const NO_KEYRING = 'not implemented';
export function osCipher(_s: SafeStorageLike, _p: NodeJS.Platform): { isAvailable(): boolean; encrypt(text: string): Buffer; decrypt(bytes: Buffer): string } { throw new Error('not implemented'); }
