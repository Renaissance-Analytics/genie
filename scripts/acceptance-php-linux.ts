/**
 * ACCEPTANCE — GENIE'S OWN PHP ON LINUX, BUILT FROM php.net's SOURCE, FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`,
 * TC5). Runs in omarchy-test with the PRODUCT's functions and real effects: php.net's real tarball and release JSON, the
 * real configure/make/install, the real binaries.
 *
 *   1. a tampered sha256 is refused, and nothing of it is left;
 *   2. Install PHP: built and proven; `php -m` lists every extension Genie's php.ini enables;
 *   3. the php-cgi a PINNED site runs (resolvePhpCgi — the product's command) runs a script with opcache ACTIVE;
 *   4. as the DEFAULT, `php` resolves BY NAME through current/php to that build;
 *   5. listed as managed; Remove deletes it and it is no longer listed.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-php-linux.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP_INI_EXTENSIONS } from '../src/core/php-versions.js';
import { httpFetch, installPhpVersion, listPhpVersions, managedPhp, nodePhpVersionsFs, removePhpVersion, resolvePhpCgi, type PhpVersionsPorts } from '../src/main/php-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-php-accept-'));
    const toolchainDir = join(base, 'genie2-toolchain');
    const root = join(toolchainDir, 'php-versions');
    nodePhpVersionsFs().mkdirp(root);
    const ports: PhpVersionsPorts = {
        platform: 'linux', root, fs: nodePhpVersionsFs(), run, cpus: availableParallelism(),
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = '8.4.27';

    console.log("1. a tampered release JSON");
    const tampered = await installPhpVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/"sha256":\s*"[0-9a-f]{64}"/g, `"sha256":"${'f'.repeat(64)}"`) } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha256 php\.net publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : JSON.stringify(tampered));
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Build PHP ${V} from php.net's source`);
    const t0 = Date.now();
    const installed = await installPhpVersion(V, true, ports);
    check(installed.kind === 'installed', `built and installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    const dir = installed.dir;
    const ini = join(dir, 'php.ini');
    const mods = execFileSync(join(dir, 'php'), ['-c', ini, '-m'], { encoding: 'utf8' });
    const loaded = new Set(mods.split(/\r?\n/).map((l) => l.trim().toLowerCase()));
    const missing = PHP_INI_EXTENSIONS.filter((e) => !loaded.has(e));
    check(missing.length === 0, `php -m lists all ${PHP_INI_EXTENSIONS.length} extensions Genie enables`, missing.join(', ') || 'all there');
    check(!/Warning|already loaded/i.test(mods), 'no start-up warning (no extension loaded twice)', mods.split('\n').find((l) => /Warning/i.test(l)) ?? '');
    check(nodePhpVersionsFs().list(root).every((e) => !e.startsWith('.')), 'no staging or tarball left', nodePhpVersionsFs().list(root).join(', '));

    console.log('3. what a pinned site runs');
    const cgi = resolvePhpCgi(V, ports);
    check(cgi.ok && cgi.command === `${join(dir, 'php-cgi')} -c ${ini}`, "resolvePhpCgi names this build's php-cgi and php.ini", cgi.ok ? cgi.command : cgi.reason);
    const script = join(mkdtempSync(join(tmpdir(), 'genie-php-script-')), 'probe.php');
    writeFileSync(script, '<?php $s = opcache_get_status(false); echo PHP_VERSION, " ", $s !== false && $s["opcache_enabled"] ? "opcache-on" : "opcache-off", " ", extension_loaded("pdo_pgsql") ? "pgsql" : "-";\n');
    const out = execFileSync(join(dir, 'php-cgi'), ['-c', ini, '-q', script], { encoding: 'utf8', env: { ...process.env, SCRIPT_FILENAME: script, REDIRECT_STATUS: '200' } }).trim();
    check(out === `${V} opcache-on pgsql`, 'php-cgi runs a script, with opcache ACTIVE', out);

    console.log('4. PHP as the default');
    const linkPorts = { platform: 'linux' as const, toolchainDir, fs: nodeLinkFs('linux') };
    check(setDefault('php', V, { ...linkPorts, managed: () => managedPhp(ports).map((m) => m.version) }).kind === 'set', 'setDefault php');
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    restoreDefaultsEnv({ ...linkPorts, env: { get: () => env.PATH, set: (_n, v) => { env.PATH = v; } } });
    const which = execFileSync('sh', ['-c', 'command -v php'], { encoding: 'utf8', env }).trim();
    check(which === join(toolchainDir, 'current', 'php', 'php'), '`php` by name is current/php/php', which);
    const v = execFileSync('sh', ['-c', 'php -v'], { encoding: 'utf8', env }).split('\n')[0] ?? '';
    check(v.startsWith(`PHP ${V} `), '`php -v` by name names it', v);
    check(setDefault('php', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

    console.log('5. list and Remove');
    check((await listPhpVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removePhpVersion(V, [], ports).kind === 'removed' && !(await listPhpVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
