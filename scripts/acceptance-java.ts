/**
 * ACCEPTANCE — GENIE'S OWN JAVA (TEMURIN), FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6d). Runs in a test VM
 * (Windows and Linux) with the PRODUCT's functions and real effects: Adoptium's real archive and release record.
 *
 *   1. a tampered release record (wrong sha256) is refused, and nothing of it is left;
 *   2. Install the newest LTS line's release for this OS: proven (this Temurin build; javac answers);
 *   3. as the DEFAULT: `java` by name is current/java/bin, JAVA_HOME is set, and a program is compiled with javac and
 *      run with java;
 *   4. listed as managed; Remove deletes it and it is no longer listed;
 *   5. Windows: nothing registered (HKLM\SOFTWARE\JavaSoft absent, with a positive reg-query control first).
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-java.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JAVA_RECIPES, javaIdOf, javaRelease } from '../src/core/java-versions.js';
import { installJavaVersion, listJavaVersions, managedJava, removeJavaVersion, type JavaVersionsPorts } from '../src/main/java-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const regHas = (key: string) => spawnSync('reg', ['query', key], { encoding: 'utf8' }).status === 0;

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-java-accept-'));
    const toolchainDir = join(base, 'genie2-toolchain');
    const root = join(toolchainDir, 'java-versions');
    nodePhpVersionsFs().mkdirp(root);
    const platform = process.platform as 'win32' | 'linux';
    const ports: JavaVersionsPorts = {
        platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run,
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = javaIdOf(javaRelease(JAVA_RECIPES[0]!, platform)!);

    console.log('1. a tampered release record');
    const tampered = await installJavaVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/"checksum":\s*"[0-9a-f]{64}"/g, `"checksum":"${'f'.repeat(64)}"`) } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha256 Adoptium publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : JSON.stringify(tampered));
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install Java ${V} (Temurin)`);
    const t0 = Date.now();
    const installed = await installJavaVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;

    console.log('3. Java as the default');
    const linkPorts = { platform, toolchainDir, fs: nodeLinkFs(platform) };
    check(setDefault('java', V, { ...linkPorts, managed: () => managedJava(ports).map((m) => m.version) }).kind === 'set', 'setDefault java');
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    restoreDefaultsEnv({ ...linkPorts, env: { get: (n) => env[n === 'PATH' ? pathKey : n], set: (n, v) => { env[n === 'PATH' ? pathKey : n] = v; } } });
    check(env.JAVA_HOME === join(toolchainDir, 'current', 'java'), 'JAVA_HOME is current/java', env.JAVA_HOME ?? '(unset)');
    // In a working directory, never `cd "<dir>"` inside the command: Node re-quotes a cmd.exe argument and cmd then
    // rejects the path (measured on the Windows VM).
    const byName = (cmd: string, cwd?: string) => (platform === 'win32' ? execFileSync('cmd.exe', ['/d', '/c', `${cmd} 2>&1`], { encoding: 'utf8', env, ...(cwd ? { cwd } : {}) }) : execFileSync('sh', ['-c', `${cmd} 2>&1`], { encoding: 'utf8', env, ...(cwd ? { cwd } : {}) })).trim();
    check(byName('java -version').includes(`Temurin-${V}`), '`java -version` by name is this Temurin build', byName('java -version').split(/\r?\n/)[1] ?? '');
    const work = mkdtempSync(join(tmpdir(), 'genie-java-app-'));
    writeFileSync(join(work, 'Hello.java'), 'public class Hello { public static void main(String[] a) { System.out.println("Hello from Genie\'s Java " + Runtime.version().feature()); } }\n');
    const out = byName('javac Hello.java && java Hello', work);
    check(out === `Hello from Genie's Java ${JAVA_RECIPES[0]!.line}`, 'javac compiles and java runs a program, by name', out);
    check(setDefault('java', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

    console.log('4. list and Remove');
    check((await listJavaVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removeJavaVersion(V, ports).kind === 'removed' && !(await listJavaVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    if (platform === 'win32') {
        console.log('5. nothing registered');
        const control = 'HKCU\\Software\\GenieAcceptanceControl';
        execFileSync('reg', ['add', control, '/f']);
        check(regHas(control), 'CONTROL: reg query sees a key that exists');
        execFileSync('reg', ['delete', control, '/f']);
        check(!regHas('HKLM\\SOFTWARE\\JavaSoft') && !regHas('HKLM\\SOFTWARE\\Eclipse Adoptium'), 'no JavaSoft or Eclipse Adoptium keys');
    }

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
