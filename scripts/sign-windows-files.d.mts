/** Authenticode signing for programs electron-builder never sees (scripts/sign-windows-files.mjs, Tynn #1058 L8). */
export interface SignOptions {
    endpoint: string;
    certificateProfileName: string;
    codeSigningAccountName: string;
    fileDigest: string;
    timestampRfc3161: string;
    timestampDigest: string;
}
export function signOptionsOf(ymlText: string): SignOptions;
export function trustedSigningCommand(o: SignOptions, file: string): string;
