/**
 * ACCEPTANCE — GENIE'S OWN .NET, FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6a). Runs in a test VM (Windows
 * and Linux) with the PRODUCT's functions and real effects: Microsoft's real archive and releases.json (sha512), the real
 * unpack, the real dotnet.
 *
 *   1. a tampered release list (wrong sha512) is refused, and nothing of it is left;
 *   2. Install the SDK: proven by its own --list-sdks; a new console app builds and runs;
 *   3. as the DEFAULT: `dotnet` by name is current/dotnet, DOTNET_ROOT is set, and a PUBLISHED app (its own apphost,
 *      which finds the runtime only through DOTNET_ROOT here) runs;
 *   4. Remove AFTER that build — the build servers it left running hold the SDK's files (measured) — removes it;
 *   5. Windows: nothing registered (HKLM\SOFTWARE\dotnet absent, with a positive reg-query control first).
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-dotnet.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOTNET_RECIPES, dotnetBinaryName } from '../src/core/dotnet-versions.js';
import { installDotnetVersion, listDotnetVersions, managedDotnet, removeDotnetVersion, type DotnetVersionsPorts } from '../src/main/dotnet-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const regHas = (key: string) => spawnSync('reg', ['query', key], { encoding: 'utf8' }).status === 0;

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-dotnet-accept-'));
    const toolchainDir = join(base, 'genie2-toolchain');
    const root = join(toolchainDir, 'dotnet-versions');
    nodePhpVersionsFs().mkdirp(root);
    const platform = process.platform as DotnetVersionsPorts['platform'];
    const ports: DotnetVersionsPorts = {
        platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run,
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = DOTNET_RECIPES[0]!.version;
    const quiet = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };

    console.log('1. a tampered release list');
    const tampered = await installDotnetVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/"hash":\s*"[0-9a-f]{128}"/g, `"hash": "${'f'.repeat(128)}"`) } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha512 Microsoft publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : JSON.stringify(tampered));
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install .NET SDK ${V}`);
    const t0 = Date.now();
    const installed = await installDotnetVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    const dn = join(installed.dir, dotnetBinaryName(platform));
    const work = mkdtempSync(join(tmpdir(), 'genie-dotnet-app-'));
    const app = join(work, 'app');
    execFileSync(dn, ['new', 'console', '-o', app], { encoding: 'utf8', env: { ...process.env, ...quiet } });
    const ran = execFileSync(dn, ['run', '--project', app], { encoding: 'utf8', env: { ...process.env, ...quiet } }).trim();
    check(ran.endsWith('Hello, World!'), 'a new console app builds and runs', ran.split('\n').pop() ?? '');

    console.log('3. .NET as the default');
    const linkPorts = { platform, toolchainDir, fs: nodeLinkFs(platform) };
    check(setDefault('dotnet', V, { ...linkPorts, managed: () => managedDotnet(ports).map((m) => m.version) }).kind === 'set', 'setDefault dotnet');
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...quiet };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    restoreDefaultsEnv({ ...linkPorts, env: { get: (n) => env[n === 'PATH' ? pathKey : n], set: (n, v) => { env[n === 'PATH' ? pathKey : n] = v; } } });
    const link = join(toolchainDir, 'current', 'dotnet');
    check(env.DOTNET_ROOT === link, 'DOTNET_ROOT is current/dotnet', env.DOTNET_ROOT ?? '(unset)');
    const byName = (cmd: string) => (platform === 'win32' ? execFileSync('cmd.exe', ['/d', '/c', cmd], { encoding: 'utf8', env }) : execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env })).trim();
    check(byName('dotnet --version') === V, '`dotnet --version` by name names it', byName('dotnet --version'));
    const out = join(work, 'out');
    execFileSync(dn, ['publish', app, '-c', 'Release', '-o', out], { encoding: 'utf8', env });
    const apphost = join(out, platform === 'win32' ? 'app.exe' : 'app');
    const published = execFileSync(apphost, [], { encoding: 'utf8', env }).trim();
    check(published === 'Hello, World!', 'a PUBLISHED app (its own apphost) finds the runtime through DOTNET_ROOT', published);
    check(setDefault('dotnet', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

    console.log('4. Remove, with the build servers that build left running');
    check((await listDotnetVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    const removed = await removeDotnetVersion(V, ports);
    check(removed.kind === 'removed' && !(await listDotnetVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed', JSON.stringify(removed));

    if (platform === 'win32') {
        console.log('5. nothing registered');
        const control = 'HKCU\\Software\\GenieAcceptanceControl';
        execFileSync('reg', ['add', control, '/f']);
        check(regHas(control), 'CONTROL: reg query sees a key that exists');
        execFileSync('reg', ['delete', control, '/f']);
        check(!regHas('HKLM\\SOFTWARE\\dotnet'), 'HKLM\\SOFTWARE\\dotnet does not exist');
    }

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
