#!/usr/bin/env node
/**
 * AUTHENTICODE-SIGNS PROGRAMS electron-builder never sees (Tynn #1058 L8): the launcher, a Rust program, in the release's
 * protected Windows job, BEFORE it is packed (the spec: "Authenticode, then manifest"). The same call electron-builder 26
 * makes for the app (app-builder-lib codeSign/windowsSignAzureManager.js): the TrustedSigning PowerShell module, then
 * Invoke-TrustedSigning with electron-builder.yml's own `win.azureSignOptions`, so there is one signing identity in one
 * place. The Azure session is azure/login's, as for the app; this script holds no credential.
 *
 *   node scripts/sign-windows-files.mjs <file.exe|file.dll>...      (Windows, after azure/login)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = ['endpoint', 'certificateProfileName', 'codeSigningAccountName', 'fileDigest', 'timestampRfc3161', 'timestampDigest'];

/** electron-builder.yml's `win.azureSignOptions`, less publisherName (electron-builder does not pass it either). */
export function signOptionsOf(ymlText) {
    const yaml = createRequire(import.meta.url)('js-yaml');
    const o = yaml.load(ymlText)?.win?.azureSignOptions;
    if (!o || typeof o !== 'object') throw new Error('electron-builder.yml has no win.azureSignOptions: nothing says who signs');
    const out = {};
    for (const k of FIELDS) {
        if (typeof o[k] !== 'string' || o[k] === '') throw new Error(`win.azureSignOptions has no ${k}`);
        out[k] = o[k];
    }
    return out;
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** The PowerShell command that signs one file, in electron-builder's order of parameters. */
export function trustedSigningCommand(o, file) {
    if (!/\.(exe|dll)$/i.test(file)) throw new Error(`${file}: only a program is signed here, an .exe or a .dll`);
    const params = [
        ['Endpoint', o.endpoint], ['CertificateProfileName', o.certificateProfileName], ['CodeSigningAccountName', o.codeSigningAccountName],
        ['TimestampRfc3161', o.timestampRfc3161], ['TimestampDigest', o.timestampDigest], ['FileDigest', o.fileDigest], ['Files', file],
    ];
    return `Invoke-TrustedSigning ${params.map(([k, v]) => `-${k} ${q(v)}`).join(' ')}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const files = process.argv.slice(2).map((f) => resolve(f));
    if (process.platform !== 'win32' || files.length === 0) { console.error('usage (Windows): sign-windows-files.mjs <file.exe|file.dll>...'); process.exit(2); }
    try {
        const o = signOptionsOf(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
        const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'inherit' }).status;
        // NuGet may be there already (it is on GitHub's runners); the module install is what must work.
        ps('Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser');
        if (ps('Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser') !== 0) throw new Error('the TrustedSigning module could not be installed');
        for (const f of files) {
            const cmd = trustedSigningCommand(o, f);
            console.log(`signing ${f}`);
            if (ps(`$ErrorActionPreference = 'Stop'; ${cmd}`) !== 0) throw new Error(`${f} was not signed`);
        }
    } catch (e) {
        console.error(`sign-windows-files: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
    }
}
