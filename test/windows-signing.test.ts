import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
const yaml = (file: string) => require('js-yaml').load(read(file)) ?? {};
const exclusions = ['Environment', 'WorkloadIdentity', 'ManagedIdentity', 'SharedTokenCache', 'VisualStudio',
    'VisualStudioCode', 'AzurePowerShell', 'AzureDeveloperCli', 'InteractiveBrowser'];
const azureFixture = () => ({ publisherName: 'Renaissance Analytics', endpoint: 'https://eus.codesigning.azure.net',
    certificateProfileName: 'genie-public', codeSigningAccountName: 'renaissance-analytics',
    ...Object.fromEntries(exclusions.map((name) => [`Exclude${name}Credential`, 'true'])), ExcludeAzureCliCredential: 'false' });

describe('Windows release signing', () => {
    it('selects the public profile and only the azure/login CLI credential, with SHA256 timestamps', () => {
        const win = yaml('electron-builder.yml').win;
        expect(win.azureSignOptions).toMatchObject({ ...azureFixture(), fileDigest: 'SHA256', timestampDigest: 'SHA256',
            timestampRfc3161: 'http://timestamp.acs.microsoft.com' });
        expect(win.signExts).toContain('.dll');
        expect(win.signExecutable).not.toBe(false);
        expect(win.verifyUpdateCodeSignature).not.toBe(false);
    });

    it('uses the documented adapter version', () => {
        expect(yaml('package.json').devDependencies['electron-builder']).toBe('26.17.0');
        expect(yaml('package-lock.json').packages['node_modules/app-builder-lib'].version).toBe('26.17.0');
    });

    it('gives only the Windows release job the release environment and OIDC, and verifies before uploading', () => {
        const jobs = yaml('.github/workflows/release.yml').jobs;
        const win = jobs['publish-windows'];
        expect(win, 'separate Windows job so Linux cannot obtain a signing token').toBeDefined();
        expect(win.environment).toBe('release');
        expect(win.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
        expect(jobs.publish.permissions).toEqual({ contents: 'write' });
        expect(jobs.publish.environment).toBeUndefined();
        const steps = win.steps;
        const login = steps.findIndex((s: any) => s.uses === 'azure/login@v2');
        expect(login).toBeGreaterThan(-1);
        for (const [input, variable] of [['client-id', 'AZURE_CLIENT_ID'], ['tenant-id', 'AZURE_TENANT_ID'], ['subscription-id', 'AZURE_SUBSCRIPTION_ID']]) {
            expect(steps[login].with[input!]).toBe('${{ vars.' + variable + ' }}');
        }
        const build = steps.findIndex((s: any) => /electron-builder --publish never/.test(s.run ?? ''));
        const verify = steps.findIndex((s: any) => /verify-windows-signatures.ps1/.test(s.run ?? ''));
        const upload = steps.findIndex((s: any) => /gh release upload/.test(s.run ?? ''));
        expect(build).toBeGreaterThan(login);
        expect(verify).toBeGreaterThan(build);
        expect(upload).toBeGreaterThan(verify);
        expect(jobs.verify.needs).toEqual(['publish', 'publish-windows']);
        expect(read('.github/workflows/release.yml')).not.toMatch(/AZURE_(?:CLIENT_SECRET|PASSWORD)|CSC_LINK|CSC_KEY_PASSWORD/);
        expect(steps.some((s: any) => /patch-azure-signing.cjs/.test(s.run ?? ''))).toBe(true);
    });

    it('sign-test is manual, branch constrained, secretless, and verifies before artifact upload', () => {
        const wf = yaml('.github/workflows/sign-test.yml');
        expect(Object.keys(wf.on ?? {})).toEqual(['workflow_dispatch']);
        const job = wf.jobs?.sign;
        expect(job).toBeDefined();
        expect(job.if).toBe("github.ref == 'refs/heads/next/release-signing'");
        expect(job.environment).toBe('sign-test');
        expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
        expect(job.steps.some((s: any) => s.uses === 'azure/login@v2')).toBe(true);
        const build = job.steps.findIndex((s: any) => /electron-builder --publish never/.test(s.run ?? ''));
        const verify = job.steps.findIndex((s: any) => /verify-windows-signatures.ps1/.test(s.run ?? ''));
        const upload = job.steps.findIndex((s: any) => s.uses === 'actions/upload-artifact@v4');
        expect(build).toBeGreaterThan(-1);
        expect(verify).toBeGreaterThan(build);
        expect(upload).toBeGreaterThan(verify);
        expect(read('.github/workflows/sign-test.yml')).not.toMatch(/secrets\.|--publish always|gh release/);
    });

    it('requires the app, launcher, installer and retained uninstaller and scans every exe/dll', () => {
        const script = read('scripts/verify-windows-signatures.ps1');
        for (const name of ['Get-AuthenticodeSignature', 'Genie.exe', 'resources/bin/genie-launch.exe',
            'nsis-uninstaller.exe', 'Renaissance Analytics', 'TimeStamperCertificate', 'Valid', 'Get-ChildItem', '.dll', '.exe']) {
            expect(script).toContain(name);
        }
        expect(read('scripts/after-pack.cjs')).toContain('retain-signed-uninstaller.cjs');
    });

    it('the actual Azure adapter binds exclusion switches and quoted paths correctly in Windows PowerShell', () => {
        const managerPath = require.resolve('app-builder-lib/out/codeSign/windowsSignAzureManager.js');
        let source = read(managerPath);
        if (existsSync('scripts/patch-azure-signing.cjs')) source = require('../scripts/patch-azure-signing.cjs').patchAzureSwitches(source);
        const module = { exports: {} as any };
        new Function('require', 'module', 'exports', source)(createRequire(managerPath), module, module.exports);
        let command = '';
        const manager = new module.exports.WindowsSignAzureManager({ platformSpecificBuildOptions: {}, vm: { value: {
            powershellCommand: { value: 'powershell.exe' }, toVmFile: (file: string) => file,
            exec: async (_exe: string, args: string[]) => { command = args.at(-1)!; },
        } } });
        return manager.signFile({ path: "C:\\build's folder\\Genie.exe", options: { azureSignOptions: azureFixture() } }).then(() => {
            expect(command).toContain('-ExcludeEnvironmentCredential:$true');
            expect(command).toContain('-ExcludeAzureCliCredential:$false');
            expect(command).toContain("'C:\\build''s folder\\Genie.exe'");
            if (process.platform !== 'win32') return; // same test's real PowerShell binding runs in the Windows guard job
            const params = [...exclusions, 'AzureCli'].map((name) => `[switch]$Exclude${name}Credential`).join(',');
            const stub = `function Invoke-TrustedSigning { [CmdletBinding()]param(${params},[string]$Endpoint,[string]$CertificateProfileName,[string]$CodeSigningAccountName,[string]$TimestampRfc3161,[string]$TimestampDigest,[string]$FileDigest,[string]$Files) $PSBoundParameters | ConvertTo-Json -Compress };`;
            const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', stub + command], { encoding: 'utf8' });
            expect(result.status, result.stderr).toBe(0);
            const bound = JSON.parse(result.stdout);
            for (const name of exclusions) expect(bound[`Exclude${name}Credential`].IsPresent).toBe(true);
            expect(bound.ExcludeAzureCliCredential.IsPresent).toBe(false);
            expect(bound.Files).toBe("C:\\build's folder\\Genie.exe");
        });
    });
});
