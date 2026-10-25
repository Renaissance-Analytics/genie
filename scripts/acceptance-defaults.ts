/**
 * ACCEPTANCE — A LANGUAGE'S DEFAULT, FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC3a). In a test VM, with
 * the PRODUCT's functions and real effects: two real Go installs from go.dev, the real `current/go` link (a symlink here,
 * a directory junction on Windows), the real PATH Genie would give its children, and a real `go version` resolved
 * THROUGH that PATH — not by path.
 *
 *   1. Make 1.27.3 the default → `go` on Genie's PATH is 1.27.3;
 *   2. switch to 1.26.10 → the SAME PATH now runs 1.26.10 (the link moved, the PATH did not);
 *   3. "use the system's" → the link is gone, and BOTH version directories are still there, untouched (removing a link
 *      must never delete what it points at — the junction case on Windows is the one this guards).
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-defaults.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GO_RECIPES, goBinaryName } from '../src/core/go-versions.js';
import { currentLinkDir, defaultPathEntry } from '../src/core/toolchain-defaults.js';
import { installGoVersion, managedGo, type GoVersionsPorts } from '../src/main/go-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { listDefaults, nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };

async function main(): Promise<void> {
    const platform = process.platform as GoVersionsPorts['platform'];
    const tc = join(mkdtempSync(join(tmpdir(), 'genie-defaults-')), 'genie2-toolchain');
    const root = join(tc, 'go-versions');
    nodePhpVersionsFs().mkdirp(root);
    const goPorts: GoVersionsPorts = { platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run, fetchBytes: httpFetch.bytes, fetchText: httpFetch.text };
    const [A, B] = [GO_RECIPES[0]!.version, GO_RECIPES[1]!.version];
    for (const v of [A, B]) {
        const r = await installGoVersion(v, true, goPorts);
        check(r.kind === 'installed', `Go ${v} installed for real`, r.kind === 'installed' ? r.dir : JSON.stringify(r));
        if (r.kind !== 'installed') return;
    }
    const linkPorts = { platform, toolchainDir: tc, fs: nodeLinkFs(platform), managed: () => managedGo(goPorts).map((m) => m.version) };
    // The PATH Genie gives its children, starting from this VM's own (which may have its own go, or none).
    const env = new Map<string, string>([['PATH', process.env['PATH'] ?? '']]);
    const envPort = { get: (n: string) => env.get(n), set: (n: string, v: string) => { env.set(n, v); } };
    const goOnPath = (): string => { try { return execFileSync(goBinaryName(platform), ['version'], { encoding: 'utf8', env: { ...process.env, PATH: env.get('PATH')! } }).trim(); } catch (e) { return `none (${e instanceof Error ? e.message.split('\n')[0] : e})`; } };

    console.log(`1. Make Go ${A} the default`);
    check(setDefault('go', A, linkPorts).kind === 'set', `set`, JSON.stringify(listDefaults(linkPorts)));
    const applied = restoreDefaultsEnv({ ...linkPorts, env: envPort });
    check(applied[0] === defaultPathEntry(tc, 'go', platform) && env.get('PATH')!.startsWith(applied[0]!), 'Genie’s PATH starts with the fixed current/go entry', applied.join(', '));
    check(goOnPath().startsWith(`go version go${A} `), `\`go\` through that PATH is ${A}`, goOnPath());

    console.log(`2. Switch to Go ${B}`);
    const pathBefore = env.get('PATH');
    check(setDefault('go', B, linkPorts).kind === 'set', 'switched');
    restoreDefaultsEnv({ ...linkPorts, env: envPort });
    check(env.get('PATH') === pathBefore, 'the PATH itself did not change (only the link moved)');
    check(goOnPath().startsWith(`go version go${B} `), `the SAME PATH now runs ${B}`, goOnPath());

    console.log('3. Use the system’s');
    check(setDefault('go', null, linkPorts).kind === 'cleared', 'cleared');
    check(!existsSync(currentLinkDir(tc, 'go')), 'current/go is gone');
    check([A, B].every((v) => existsSync(join(root, v, 'bin', goBinaryName(platform)))), 'BOTH versions are still installed, untouched by removing the link');
    check(listDefaults(linkPorts).go === null, 'no Go default is listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
