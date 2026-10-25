/**
 * ACCEPTANCE — GENIE'S OWN GO, FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, TC2a). Runs in a test VM with the
 * PRODUCT's functions and real effects: the real go.dev archive, go.dev's real release index for the sha256, the real
 * unpack (tar on macOS/Linux, Expand-Archive on Windows), and the real `go version`.
 *
 *   1. a tampered index (wrong sha256) is refused, and nothing of it is left;
 *   2. Install Go: installed, `go version` names the version and this platform, and it compiles and runs a program;
 *   3. listed as managed; Remove deletes it and it is no longer listed.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-go.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GO_RECIPES, goBinaryName } from '../src/core/go-versions.js';
import { installGoVersion, listGoVersions, removeGoVersion, type GoVersionsPorts } from '../src/main/go-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
// The product's runner for installs (main.ts `longRunner`): an unpack takes longer than the prober's 20 s default.
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-go-accept-'));
    const root = join(base, 'genie2-toolchain', 'go-versions');
    nodePhpVersionsFs().mkdirp(root);
    const platform = process.platform as GoVersionsPorts['platform'];
    const ports: GoVersionsPorts = {
        platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run,
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = GO_RECIPES[0]!.version;

    console.log('1. a tampered release index');
    const tampered = await installGoVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/"sha256":\s*"[0-9a-f]{64}"/g, `"sha256":"${'f'.repeat(64)}"`) } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha256 go\.dev publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : tampered.kind);
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install Go ${V}`);
    const t0 = Date.now();
    const installed = await installGoVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    const go = join(installed.dir, 'bin', goBinaryName(platform));
    const said = execFileSync(go, ['version'], { encoding: 'utf8' }).trim();
    check(said.startsWith(`go version go${V} `), '`go version` names it', said);
    const work = mkdtempSync(join(tmpdir(), 'genie-go-prog-'));
    writeFileSync(join(work, 'main.go'), 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello from genie go") }\n');
    const out = execFileSync(go, ['run', join(work, 'main.go')], { encoding: 'utf8', env: { ...process.env, GOCACHE: join(work, 'cache'), GOPATH: join(work, 'gopath') } }).trim();
    check(out === 'hello from genie go', 'it compiles and runs a program', out);

    console.log('3. list and Remove');
    check((await listGoVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removeGoVersion(V, ports).kind === 'removed' && !(await listGoVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
