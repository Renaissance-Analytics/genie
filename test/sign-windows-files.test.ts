import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signOptionsOf, trustedSigningCommand } from '../scripts/sign-windows-files.mjs';

/**
 * THE LAUNCHER IS AUTHENTICODE-SIGNED BY THE SAME IDENTITY AS THE APP (Tynn #1058 L8; the spec's "Signed executables").
 * electron-builder signs the client's programs as it builds them; the launcher is a Rust program it never sees, so the
 * release's Windows job signs it with scripts/sign-windows-files.mjs BEFORE it is packed. That script makes the same call
 * electron-builder 26 makes (app-builder-lib codeSign/windowsSignAzureManager.js: Install-Module TrustedSigning, then
 * Invoke-TrustedSigning with azureSignOptions), from electron-builder.yml's own azureSignOptions: one identity, one place.
 */
const yml = () => readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');

describe('sign-windows-files', () => {
    it('reads the signing identity from electron-builder.yml, the one the app is signed with', () => {
        expect(signOptionsOf(yml())).toEqual({
            endpoint: 'https://eus.codesigning.azure.net',
            certificateProfileName: 'genie-public',
            codeSigningAccountName: 'renaissance-analytics',
            fileDigest: 'SHA256',
            timestampRfc3161: 'http://timestamp.acs.microsoft.com',
            timestampDigest: 'SHA256',
        });
    });

    it('refuses a configuration with no azureSignOptions, or one missing a field, rather than signing with a default', () => {
        expect(() => signOptionsOf('win:\n  target: nsis\n')).toThrow(/azureSignOptions/);
        expect(() => signOptionsOf('win:\n  azureSignOptions:\n    endpoint: https://x\n')).toThrow(/certificateProfileName/);
    });

    it('makes electron-builder\'s call, every value quoted for PowerShell', () => {
        const o = signOptionsOf(yml());
        expect(trustedSigningCommand(o, "D:\\a\\genie\\it's\\Genie.exe")).toBe(
            "Invoke-TrustedSigning -Endpoint 'https://eus.codesigning.azure.net' -CertificateProfileName 'genie-public' "
            + "-CodeSigningAccountName 'renaissance-analytics' -TimestampRfc3161 'http://timestamp.acs.microsoft.com' "
            + "-TimestampDigest 'SHA256' -FileDigest 'SHA256' -Files 'D:\\a\\genie\\it''s\\Genie.exe'",
        );
    });

    it('signs programs only: an .exe or a .dll', () => {
        const o = signOptionsOf(yml());
        expect(() => trustedSigningCommand(o, 'C:\\x\\manifest.json')).toThrow(/\.exe or a \.dll/);
    });
});
