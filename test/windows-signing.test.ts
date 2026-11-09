import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
const yaml = (file: string) => require('js-yaml').load(read(file)) ?? {};
const azureFixture = () => ({ publisherName: 'Renaissance Analytics', endpoint: 'https://eus.codesigning.azure.net',
    certificateProfileName: 'genie-public', codeSigningAccountName: 'renaissance-analytics' });

type UploadRun = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'stdout' | 'stderr'>;

/** What one spawn of the upload script must have done, for a release in this state. */
function expectUploadRun(state: string, run: UploadRun): void {
    const status = run.status === null ? 'null' : `${run.status} (0x${(run.status >>> 0).toString(16)})`;
    const seen = `release state ${state}: status ${status}, signal ${run.signal}, stdout ${JSON.stringify(run.stdout)}, stderr ${JSON.stringify(run.stderr)}`;
    if (state === 'true') {
        expect(run.status, seen).toBe(0);
        expect(run.stdout, seen).toContain('UPLOAD_CALLED');
    } else {
        // The script's own refusal, not merely "not 0": a shell that crashed also exits non-zero.
        expect(run.status, seen).toBe(1);
        expect(run.stdout, seen).toContain('Windows upload requires an existing draft release');
        expect(run.stdout, seen).not.toContain('UPLOAD_CALLED');
    }
}

/**
 * Git Bash has died under this test on the Windows runners with status 0x80000004 and nothing on stderr. Not forced in 3,150
 * probe spawns, so no retry: a crash fails, and the failure says what happened.
 */
describe('the verdict on one spawn of the upload script', () => {
    const REFUSAL = '::error::Windows upload requires an existing draft release\n';
    const crash: UploadRun = { status: 0x80000004, signal: null, stdout: 'partial output', stderr: '' };
    const killed: UploadRun = { status: null, signal: 'SIGKILL', stdout: 'partial output', stderr: '' };
    const failureOf = (state: string, run: UploadRun): string => {
        try { expectUploadRun(state, run); } catch (error) { return String((error as Error).message); }
        return 'it did not fail';
    };

    it.each(['false', 'error'])('a crash is not a refusal: release state %s', (state) => {
        expect(() => expectUploadRun(state, crash)).toThrow();
        expect(() => expectUploadRun(state, killed)).toThrow();
        expect(() => expectUploadRun(state, { status: 127, signal: null, stdout: '', stderr: 'gh: command not found' })).toThrow();
    });

    it.each(['true', 'false', 'error'])('the failure reports the status in hex, the signal and stdout: release state %s', (state) => {
        const crashed = failureOf(state, crash);
        expect(crashed).toContain('0x80000004');
        expect(crashed).toContain('signal null');
        expect(crashed).toContain('partial output');
        const signalled = failureOf(state, killed);
        expect(signalled).toContain('signal SIGKILL');
        expect(signalled).toContain('partial output');
    });

    it('CONTROL: the two real outcomes still pass', () => {
        expect(() => expectUploadRun('true', { status: 0, signal: null, stdout: 'uploading\nUPLOAD_CALLED\n', stderr: '' })).not.toThrow();
        for (const state of ['false', 'error']) expect(() => expectUploadRun(state, { status: 1, signal: null, stdout: REFUSAL, stderr: '' })).not.toThrow();
    });
});

describe('Windows release signing', () => {
    it('selects the public profile and the unmodified default credential chain, with SHA256 timestamps', () => {
        const win = yaml('electron-builder.yml').win;
        expect(win.azureSignOptions).toMatchObject({ ...azureFixture(), fileDigest: 'SHA256', timestampDigest: 'SHA256',
            timestampRfc3161: 'http://timestamp.acs.microsoft.com' });
        expect(Object.keys(win.azureSignOptions).filter((key) => key.startsWith('Exclude'))).toEqual([]);
        // Only what ships unsigned is signed, never another publisher's file (test/win-sign-plan.test.ts proves which).
        expect(win.signExts).not.toContain('.dll');
        expect(win.signExts).toContain('!OpenConsole.exe');
        expect(win.signExecutable).not.toBe(false);
        expect(win.verifyUpdateCodeSignature).not.toBe(false);
    });

    it('uses the documented adapter version', () => {
        expect(yaml('package.json').devDependencies['electron-builder']).toBe('^26.5.0');
        expect(yaml('package-lock.json').packages['node_modules/app-builder-lib'].version).toBe('26.15.3');
    });

    it('the pinned builder signs extra-resource executables and DLLs while copying them', () => {
        // Enter at the package root so its CommonJS platform-packager cycle initializes normally.
        require('app-builder-lib');
        const { WinPackager } = require('app-builder-lib/out/winPackager.js');
        const packager = Object.create(WinPackager.prototype);
        packager.platformSpecificBuildOptions = { signExts: ['.dll'] };
        const context = { appOutDir: 'C:/out/win-unpacked' };
        expect(packager.createTransformerForExtraFiles(context)('C:/input/genie-launch.exe')).not.toBeNull();
        expect(packager.createTransformerForExtraFiles(context)('C:/input/ours.dll')).not.toBeNull();
        expect(packager.createTransformerForExtraFiles(context)('C:/input/icon.png')).toBeNull();
        packager.platformSpecificBuildOptions.signExecutable = false;
        expect(packager.createTransformerForExtraFiles(context)).toBeNull();
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
        expect(steps.some((s: any) => /patch-azure-signing.cjs/.test(s.run ?? ''))).toBe(false);
        expect(existsSync('scripts/patch-azure-signing.cjs')).toBe(false);
    });

    it('sign-test queues only the signing branch for owner approval and also permits later manual dispatch', () => {
        const wf = yaml('.github/workflows/sign-test.yml');
        expect(new Set(Object.keys(wf.on ?? {}))).toEqual(new Set(['push', 'workflow_dispatch']));
        expect(wf.on.push.branches).toEqual(['next/release-signing']);
        expect(wf.on.push.tags).toBeUndefined();
        const job = wf.jobs?.sign;
        expect(job).toBeDefined();
        expect(job.if).toBe("github.ref == 'refs/heads/next/release-signing'");
        expect(job.environment).toBe('sign-test');
        expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
        expect(job.steps.some((s: any) => s.uses === 'azure/login@v2')).toBe(true);
        const build = job.steps.findIndex((s: any) => /electron-builder --publish never/.test(s.run ?? ''));
        const verify = job.steps.findIndex((s: any) => /verify-windows-signatures.ps1/.test(s.run ?? ''));
        const updater = job.steps.findIndex((s: any) => /verify-windows-update.cjs/.test(s.run ?? ''));
        const upload = job.steps.findIndex((s: any) => s.uses === 'actions/upload-artifact@v4');
        expect(build).toBeGreaterThan(-1);
        expect(verify).toBeGreaterThan(build);
        expect(updater).toBeGreaterThan(verify);
        expect(upload).toBeGreaterThan(updater);
        expect(job.steps.some((s: any) => /gh release view v2\.0\.0-beta\.59/.test(s.run ?? ''))).toBe(true);
        expect(job.steps[upload].with.path).toContain('release/latest.yml');
        expect(job.steps[upload].with.path).toContain('release/*-setup.exe.blockmap');
        expect(read('.github/workflows/sign-test.yml')).not.toMatch(/secrets\.|--publish always|gh release (?:create|edit|upload|delete)/);
    });

    it('release also verifies the updater after signing and before uploading the three updater assets', () => {
        const steps = yaml('.github/workflows/release.yml').jobs['publish-windows'].steps;
        const verify = steps.findIndex((s: any) => /verify-windows-signatures.ps1/.test(s.run ?? ''));
        const updater = steps.findIndex((s: any) => /verify-windows-update.cjs/.test(s.run ?? ''));
        const upload = steps.findIndex((s: any) => /gh release upload/.test(s.run ?? ''));
        expect(updater).toBeGreaterThan(verify);
        expect(upload).toBeGreaterThan(updater);
        for (const name of ['Genie-$tag-setup.exe', 'Genie-$tag-setup.exe.blockmap', 'release/latest.yml']) expect(steps[upload].run).toContain(name);
    });

    it('the actual Windows upload script refuses a public or unreadable release at upload time', () => {
        const steps = yaml('.github/workflows/release.yml').jobs['publish-windows'].steps;
        const script = steps.find((step: any) => /gh release upload/.test(step.run ?? '')).run;
        // Replace only gh with a local shell function: exercise the actual workflow script,
        // with no token/network/upload. A release may change while the signing job runs.
        const stub = `gh() { if [ "$2" = view ]; then
            if [ "$RELEASE_STATE" = error ]; then return 1; fi
            printf '%s\\n' "$RELEASE_STATE"
        elif [ "$2" = upload ]; then echo UPLOAD_CALLED; else return 1; fi; };\n`;
        for (const state of ['true', 'false', 'error']) {
            const run = spawnSync('bash', ['-e', '-c', stub + script], { encoding: 'utf8', env: { ...process.env,
                RELEASE_STATE: state, GITHUB_REF_NAME: 'v0.0.0', GITHUB_REPOSITORY: 'fixture/genie' } });
            expectUploadRun(state, run);
        }
    });

    it('requires the app, launcher, installer and retained uninstaller and scans every exe/dll', () => {
        const script = read('scripts/verify-windows-signatures.ps1');
        for (const name of ['Get-AuthenticodeSignature', 'Genie.exe', 'resources/bin/genie-launch.exe',
            'nsis-uninstaller.exe', 'Renaissance Analytics', 'TimeStamperCertificate', 'Valid', 'Get-ChildItem', '.dll', '.exe']) {
            expect(script).toContain(name);
        }
        expect(read('scripts/after-pack.cjs')).toContain('retain-signed-uninstaller.cjs');
    });

    it('the unmodified locked Azure adapter binds the profile and quoted paths in Windows PowerShell', () => {
        const managerPath = require.resolve('app-builder-lib/out/codeSign/windowsSignAzureManager.js');
        const source = read(managerPath);
        const module = { exports: {} as any };
        new Function('require', 'module', 'exports', source)(createRequire(managerPath), module, module.exports);
        let command = '';
        const manager = new module.exports.WindowsSignAzureManager({ platformSpecificBuildOptions: {}, vm: { value: {
            powershellCommand: { value: 'powershell.exe' }, toVmFile: (file: string) => file,
            exec: async (_exe: string, args: string[]) => { command = args.at(-1)!; },
        } } });
        return manager.signFile({ path: "C:\\build's folder\\Genie.exe", options: { azureSignOptions: azureFixture() } }).then(() => {
            expect(command).toContain("'C:\\build''s folder\\Genie.exe'");
            expect(command).not.toContain('-Exclude');
            if (process.platform !== 'win32') return;
            const stub = `function Invoke-TrustedSigning { [CmdletBinding()]param([string]$Endpoint,[string]$CertificateProfileName,[string]$CodeSigningAccountName,[string]$TimestampRfc3161,[string]$TimestampDigest,[string]$FileDigest,[string]$Files) $PSBoundParameters | ConvertTo-Json -Compress };`;
            const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', stub + command], { encoding: 'utf8' });
            expect(result.status, result.stderr).toBe(0);
            const bound = JSON.parse(result.stdout);
            expect(bound.Endpoint).toBe('https://eus.codesigning.azure.net');
            expect(bound.CertificateProfileName).toBe('genie-public');
            expect(bound.CodeSigningAccountName).toBe('renaissance-analytics');
            expect(bound.Files).toBe("C:\\build's folder\\Genie.exe");
        });
    });

    it('retains exactly the signed uninstaller bytes, only after successful signing', async () => {
        expect(existsSync('scripts/retain-signed-uninstaller.cjs')).toBe(true);
        const retain = require('../scripts/retain-signed-uninstaller.cjs');
        const dir = mkdtempSync(join(tmpdir(), 'genie-sign-retain-'));
        try {
            const uninstaller = join(dir, 'Genie-setup.__uninstaller.exe');
            const app = join(dir, 'Genie.exe');
            writeFileSync(uninstaller, 'unsigned');
            writeFileSync(app, 'app');
            const packager = { platformSpecificBuildOptions: {}, async signIf(file: string) {
                writeFileSync(file, 'signed by fixture'); return true;
            } };
            retain({ packager, outDir: dir });
            await packager.signIf(app);
            expect(existsSync(join(dir, 'signature-evidence/nsis-uninstaller.exe'))).toBe(false);
            await packager.signIf(uninstaller);
            expect(readFileSync(join(dir, 'signature-evidence/nsis-uninstaller.exe'), 'utf8')).toBe('signed by fixture');
            const refused = { platformSpecificBuildOptions: {}, async signIf(_file: string) { return false; } };
            retain({ packager: refused, outDir: join(dir, 'refused') });
            await expect(refused.signIf(uninstaller)).rejects.toThrow(/uninstaller/i);
            expect(existsSync(join(dir, 'refused/signature-evidence/nsis-uninstaller.exe'))).toBe(false);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('the actual verifier rejects bad signatures, wrong publisher, no timestamp and missing payloads', () => {
        expect(existsSync('scripts/verify-windows-signatures.ps1')).toBe(true);
        if (process.platform !== 'win32') return; // actual PowerShell script runs on the Windows guard row
        const dir = mkdtempSync(join(tmpdir(), 'genie-sign-verify-'));
        const files = ['win-unpacked/Genie.exe', 'win-unpacked/resources/bin/genie-launch.exe',
            'win-unpacked/resources/deep/ours.dll', 'Genie-test-setup.exe', 'signature-evidence/nsis-uninstaller.exe'];
        try {
            for (const file of files) {
                const dest = join(dir, file);
                mkdirSync(join(dest, '..'), { recursive: true });
                writeFileSync(dest, 'fixture');
            }
            const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
            const run = (bad = '', kind = '') => {
                const mock = `$ErrorActionPreference='Stop'; function Get-AuthenticodeSignature { param([string]$LiteralPath)
                    $bad = (Split-Path -Leaf $LiteralPath) -eq ${quote(bad)}
                    $cert = [pscustomobject]@{Subject='CN=Renaissance Analytics'}
                    $cert | Add-Member ScriptMethod GetNameInfo { param($type,$issuer) 'Renaissance Analytics' }
                    if ($bad -and ${quote(kind)} -eq 'publisher') { $cert.Subject='CN=Someone Else'; $cert | Add-Member -Force ScriptMethod GetNameInfo { param($type,$issuer) 'Someone Else' } }
                    [pscustomobject]@{ Status=$(if ($bad -and ${quote(kind)} -eq 'status') {'NotSigned'} else {'Valid'}); SignerCertificate=$cert; TimeStamperCertificate=$(if ($bad -and ${quote(kind)} -eq 'timestamp') {$null} else {[pscustomobject]@{Subject='Timestamp authority'}}) }
                }; & ./scripts/verify-windows-signatures.ps1 -ReleaseDir ${quote(dir)}`;
                // Match the workflow's shell; Windows PowerShell inherits pwsh's incompatible module path.
                return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', mock], { encoding: 'utf8' });
            };
            const valid = run();
            expect(valid.status, valid.stderr).toBe(0);
            for (const file of files) expect(valid.stdout).toContain(file.split('/').at(-1));
            for (const file of files) {
                const invalid = run(file.split('/').at(-1), 'status');
                expect(invalid.status, `unsigned ${file} passed: ${invalid.stdout}`).not.toBe(0);
            }
            for (const kind of ['publisher', 'timestamp']) expect(run('ours.dll', kind).status).not.toBe(0);
            for (const file of ['win-unpacked/Genie.exe', 'win-unpacked/resources/bin/genie-launch.exe', 'signature-evidence/nsis-uninstaller.exe', 'Genie-test-setup.exe']) {
                rmSync(join(dir, file));
                expect(run().status, `missing ${file} passed`).not.toBe(0);
                writeFileSync(join(dir, file), 'fixture');
            }
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
