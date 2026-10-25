/**
 * ACCEPTANCE — GENIE'S OWN RUBY ON WINDOWS (RubyInstaller), FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6e).
 * Runs in the Windows test VM with the PRODUCT's functions and real effects: RubyInstaller's real .7z and GitHub's real
 * downloads page (its SHA256), Windows' own tar.exe, the real ruby.
 *
 *   1. a tampered downloads page (wrong SHA256) is refused, and nothing of it is left;
 *   2. Install Ruby: proven (openssl, psych, zlib, fiddle load; this version and platform; gem answers);
 *   3. as the DEFAULT: `ruby` by name is current\ruby\bin\ruby.exe; `gem install` puts a gem in place and its command
 *      runs by name; `bundle install` + `bundle exec` resolve and load a Gemfile;
 *   4. nothing registered and the user's PATH untouched (a positive reg-query control first);
 *   5. listed as managed; Remove deletes it and it is no longer listed.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-ruby-windows.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUBY_RECIPES } from '../src/core/ruby-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { installRubyVersion, listRubyVersions, managedRuby, removeRubyVersion, type RubyVersionsPorts } from '../src/main/ruby-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const regHas = (key: string) => spawnSync('reg', ['query', key], { encoding: 'utf8' }).status === 0;
const userPath = () => spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' }).stdout;

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-ruby-win-accept-'));
    const toolchainDir = join(base, 'genie2-toolchain');
    const root = join(toolchainDir, 'ruby-versions');
    nodePhpVersionsFs().mkdirp(root);
    const ports: RubyVersionsPorts = {
        platform: 'win32', arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run,
        windowsTar: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'),
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = RUBY_RECIPES[0]!.version;
    const pathBefore = userPath();

    console.log('1. a tampered downloads page');
    const tampered = await installRubyVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/value="[0-9a-f]{64}"/g, `value="${'f'.repeat(64)}"`) } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha256 RubyInstaller publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : JSON.stringify(tampered));
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install Ruby ${V} (RubyInstaller)`);
    const t0 = Date.now();
    const installed = await installRubyVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;

    console.log('3. Ruby as the default');
    const linkPorts = { platform: 'win32' as const, toolchainDir, fs: nodeLinkFs('win32') };
    check(setDefault('ruby', V, { ...linkPorts, managed: () => managedRuby(ports).map((m) => m.version) }).kind === 'set', 'setDefault ruby');
    const gems = join(base, 'gems');
    const env: Record<string, string> = { ...(process.env as Record<string, string>), GEM_HOME: gems, GEM_PATH: gems };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
    restoreDefaultsEnv({ ...linkPorts, env: { get: (n) => env[n === 'PATH' ? pathKey : n], set: (n, v) => { env[n === 'PATH' ? pathKey : n] = v; } } });
    env[pathKey] = `${join(gems, 'bin')};${env[pathKey]}`;
    const app = mkdtempSync(join(tmpdir(), 'genie-ruby-app-'));
    const byName = (cmd: string) => execFileSync('cmd.exe', ['/d', '/c', `${cmd} 2>&1`], { encoding: 'utf8', env, cwd: app }).trim();
    const where = byName('where ruby').split(/\r?\n/)[0] ?? '';
    check(where.toLowerCase() === join(toolchainDir, 'current', 'ruby', 'bin', 'ruby.exe').toLowerCase(), '`ruby` by name is current\\ruby\\bin\\ruby.exe', where);
    check(byName('ruby -v').startsWith(`ruby ${V} `), '`ruby -v` by name names it', byName('ruby -v'));
    byName('gem install --no-document rake');
    check(/^rake, version \d/.test(byName('rake --version')), 'a gem installed by `gem` runs by name', byName('rake --version'));
    writeFileSync(join(app, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rake'\n");
    // The check as a file, never `-e "…"`: Node re-quotes a cmd.exe argument and ruby got a mangled program (measured).
    writeFileSync(join(app, 'check.rb'), "require 'rake'\nprint Rake::VERSION\n");
    const bundled = byName('bundle install --quiet && bundle exec ruby check.rb').split(/\r?\n/).pop() ?? '';
    check(/^\d+\.\d+/.test(bundled), '`bundle install` + `bundle exec` resolve and load a Gemfile', bundled);
    check(setDefault('ruby', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

    console.log('4. nothing registered');
    const control = 'HKCU\\Software\\GenieAcceptanceControl';
    execFileSync('reg', ['add', control, '/f']);
    check(regHas(control), 'CONTROL: reg query sees a key that exists');
    execFileSync('reg', ['delete', control, '/f']);
    check(!regHas('HKCU\\Software\\RubyInstaller') && !regHas('HKLM\\SOFTWARE\\RubyInstaller'), 'no RubyInstaller keys');
    check(userPath() === pathBefore, "the user's PATH is untouched");

    console.log('5. list and Remove');
    check((await listRubyVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removeRubyVersion(V, ports).kind === 'removed' && !(await listRubyVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
