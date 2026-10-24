/**
 * ACCEPTANCE — GENIE'S OWN NODE ON WINDOWS (#1149, #1155; the owner, 2026-10-23: "we better not be using herds node.
 * genie has its own install path"). Runs in the Windows test VM with the PRODUCT's functions and real effects: the real
 * nodejs.org download, the real SHASUMS256.txt, PowerShell's Expand-Archive, the real `where`.
 *
 *   1. a zip whose published sha256 does not match is refused and nothing of it is left (the gauge: a tampered sums file);
 *   2. Install Node 24.22.1: installed, `node -v` names it, its own npm runs;
 *   3. Check and repair, on a PATH where ANOTHER node is first and a stand-in global npm shim is first — the positive
 *      control shows `where` finds them first BEFORE — then Genie's node and npm resolve first, and a real `npm -v`
 *      through PATH answers Genie's npm version; the next launch's restore puts it first again;
 *   4. Genie's npm broken → the repair says so and does NOT move it first;
 *   5. Remove: gone.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-node.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NODE_LTS_DEFAULT } from '../src/core/node-versions.js';
import { installNodeVersion, managedNode, removeNodeVersion, type NodeVersionsPorts } from '../src/main/node-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { checkAndRepair, nodeToolchainFs, processEnv, restoreToolchainEnv, type ToolchainOpsPorts } from '../src/main/toolchain-ops.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
// The product's runner for installs (main.ts `longRunner`): Expand-Archive of a zip this size takes longer than the
// prober's 20 s default — a first run with that default failed the unpack, and left nothing behind.
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const where = (name: string): string[] => {
    try { return execFileSync('where', [name], { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch { return []; }
};
const lower = (s: string | undefined) => (s ?? '').toLowerCase();

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-node-accept-'));
    const root = join(base, 'genie2-toolchain', 'node-versions');
    mkdirSync(root, { recursive: true });
    const V = NODE_LTS_DEFAULT;
    const ports: NodeVersionsPorts = { platform: 'win32', root, fs: nodePhpVersionsFs(), run, fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); } };

    console.log(`1. a tampered SHASUMS256.txt`);
    const tampered = await installNodeVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/^[0-9a-f]{64}(?=\s+node-v[\d.]+-win-x64\.zip)/m, 'f'.repeat(64)) } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha256 nodejs\.org publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 160) : tampered.kind);
    check(managedNode(ports).length === 0 && nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install Node ${V}`);
    const t0 = Date.now();
    const installed = await installNodeVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    const dir = installed.dir;
    check(execFileSync(join(dir, 'node.exe'), ['-v'], { encoding: 'utf8' }).trim() === `v${V}`, 'node -v names it');
    const npmV = execFileSync(join(dir, 'node.exe'), [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '-v'], { encoding: 'utf8' }).trim();
    check(/^\d+\.\d+\.\d+$/.test(npmV), 'its own npm runs', npmV);

    console.log('3. Check and repair on a PATH where another node and a global npm shim win');
    const foreignNode = dirname(process.execPath);
    const shim = join(base, 'Roaming-npm');
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'npm.cmd'), '@echo 9.8.0\r\n');
    const sys = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32`;
    process.env['PATH'] = [shim, foreignNode, sys, process.env['SystemRoot'] ?? 'C:\\Windows'].join(';');
    const nodeBefore = where('node').find((p) => /\.exe$/i.test(p));
    const npmBefore = where('npm').find((p) => /\.(cmd|exe)$/i.test(p));
    // POSITIVE CONTROL: the gauge sees the foreign copies first — so "Genie's first afterwards" is a measurement.
    check(lower(nodeBefore).startsWith(lower(foreignNode)) && lower(npmBefore).startsWith(lower(shim)), 'control: where finds the foreign node and the shim first', `${nodeBefore} | ${npmBefore}`);
    // THE MECHANISM, shown before the repair: Genie's dir first on PATH and NO prefix set (deleting NPM_CONFIG_PREFIX also
    // drops the npm_config_prefix `npx` exported to this script — Windows env names are case-insensitive) — npm.cmd then
    // finds no other prefix and runs its own npm. The first run of this acceptance, with npx's prefix inherited, got the
    // system npm 10.9.9.
    const npmCmd = () => { try { return execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm -v'], { encoding: 'utf8' }).trim().split(/\r?\n/).pop()!; } catch { return 'nothing'; } };
    const savedPath = process.env['PATH'];
    delete process.env['NPM_CONFIG_PREFIX'];
    process.env['PATH'] = [dir, savedPath].join(';');
    const prefixSaid = (() => { try { return execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm prefix -g'], { encoding: 'utf8' }).trim(); } catch { return '?'; } })();
    const unprefixed = npmCmd();
    console.log(`    probe: Genie's dir first, no prefix → npm -v ${unprefixed}; npm prefix -g = ${prefixSaid}; an npm there: ${existsSync(join(prefixSaid, 'node_modules', 'npm', 'bin', 'npm-cli.js'))}`);
    process.env['PATH'] = savedPath;
    const dataDir = join(base, 'genie2-toolchain');
    const opsPorts: ToolchainOpsPorts = {
        platform: 'win32', run, env: processEnv, fs: nodeToolchainFs(), dataDir, systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
        packageManager: async () => null, genieNode: () => managedNode(ports)[0] ?? null,
    };
    const report = await checkAndRepair(opsPorts);
    const f = report.findings.find((x) => x.kind === 'genie-node');
    check(f?.result.kind === 'repaired', 'a genie-node finding, repaired', f ? `${f.kind === 'genie-node' ? f.problem : ''} → ${JSON.stringify(f.result).slice(0, 200)}` : 'no finding');
    check(lower(where('node')[0]).startsWith(lower(dir)), 'where node: Genie’s first', where('node')[0]);
    check(lower(where('npm').find((p) => /\.(cmd|exe)$/i.test(p))).startsWith(lower(dir)), 'where npm: Genie’s first', where('npm')[0]);
    const viaPath = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm -v'], { encoding: 'utf8' }).trim();
    check(viaPath === npmV, 'npm -v through PATH is Genie’s npm', viaPath);
    check(lower(process.env['NPM_CONFIG_PREFIX']).endsWith('npm-global'), 'Genie’s npm prefix is set', process.env['NPM_CONFIG_PREFIX']);
    const fresh = new Map<string, string>([['PATH', [shim, foreignNode, sys].join(';')]]);
    restoreToolchainEnv({ platform: 'win32', env: { get: (n) => fresh.get(n), set: (n, v) => { fresh.set(n, v); } }, fs: nodeToolchainFs(), dataDir });
    check(lower(fresh.get('PATH')!.split(';')[0]) === lower(dir), 'the next launch puts it first again');

    console.log('4. Genie’s npm broken');
    const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    renameSync(cli, `${cli}.off`);
    const brokenPath = [shim, foreignNode, sys].join(';');
    process.env['PATH'] = brokenPath;
    const broken = (await checkAndRepair(opsPorts)).findings.find((x) => x.kind === 'genie-node');
    check(broken?.result.kind === 'unchanged' && /npm does not run/.test(broken.result.kind === 'unchanged' ? broken.result.reason : ''), 'said, not moved', broken ? JSON.stringify(broken.result).slice(0, 200) : 'no finding');
    check(process.env['PATH'] === brokenPath, 'PATH untouched');
    renameSync(`${cli}.off`, cli);

    console.log('5. Remove');
    check(removeNodeVersion(V, ports).kind === 'removed' && managedNode(ports).length === 0, 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
