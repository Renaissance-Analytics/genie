/**
 * ACCEPTANCE — GENIE'S OWN NODE INSTALLS FOR REAL ON THIS OS (plan `.ai/plans/genie-2-toolchain-rest.md`, TC2b). Runs in
 * a test VM with the PRODUCT's functions and real effects: the real nodejs.org archive (.zip on Windows, .tar.gz
 * elsewhere), its real SHASUMS256.txt, the real unpack, the real `node -v` and the build's OWN npm doing a real install.
 * (scripts/acceptance-node.ts is the Windows PATH/repair acceptance; this one is the install itself, on any OS.)
 *
 *   1. a tampered SHASUMS256.txt is refused, and nothing of it is left;
 *   2. Install Node: installed, `node -v` names it, its own npm runs and installs a package;
 *   3. listed as managed; Remove deletes it and it is no longer listed.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-node-install.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_LTS_DEFAULT, nodeBinaryRel, nodeNpmCliRel } from '../src/core/node-versions.js';
import { installNodeVersion, listNodeVersions, removeNodeVersion, type NodeVersionsPorts } from '../src/main/node-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-node-install-'));
    const root = join(base, 'genie2-toolchain', 'node-versions');
    nodePhpVersionsFs().mkdirp(root);
    const platform = process.platform as NodeVersionsPorts['platform'];
    const ports: NodeVersionsPorts = {
        platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run,
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = NODE_LTS_DEFAULT;

    console.log('1. a tampered SHASUMS256.txt');
    const tampered = await installNodeVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/^[0-9a-f]{64}(?=\s+node-v)/gm, 'f'.repeat(64)) } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha256 nodejs\.org publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : tampered.kind);
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install Node ${V} (${platform})`);
    const t0 = Date.now();
    const installed = await installNodeVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    const node = join(installed.dir, nodeBinaryRel(platform));
    check(execFileSync(node, ['-v'], { encoding: 'utf8' }).trim() === `v${V}`, 'node -v names it');
    const npmCli = join(installed.dir, nodeNpmCliRel(platform));
    const npmV = execFileSync(node, [npmCli, '-v'], { encoding: 'utf8' }).trim();
    check(/^\d+\.\d+\.\d+$/.test(npmV), 'its own npm runs', npmV);
    const proj = mkdtempSync(join(tmpdir(), 'genie-node-proj-'));
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'genie-accept', version: '1.0.0', private: true }));
    execFileSync(node, [npmCli, 'install', 'is-number@7.0.0', '--no-audit', '--no-fund'], { cwd: proj, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(proj, '.npm') } });
    check(existsSync(join(proj, 'node_modules', 'is-number', 'package.json')), 'its own npm installs a real package');

    console.log('3. list and Remove');
    check((await listNodeVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removeNodeVersion(V, ports).kind === 'removed' && !(await listNodeVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
