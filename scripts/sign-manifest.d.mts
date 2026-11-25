/** Signs track manifests (scripts/sign-manifest.mjs, Tynn #1058 L1). */
export function publicKeyOf(privateKeyPem: string): string;
export function signManifestBytes(bytes: Uint8Array, privateKeyPem: string): string;
