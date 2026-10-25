/**
 * ACCEPTANCE — GENIE'S OWN RUBY ON LINUX, BUILT FROM ruby-lang.org's SOURCE, FOR REAL (plan
 * `.ai/plans/genie-2-toolchain-rest.md`, TC6c). Runs in omarchy-test with the PRODUCT's functions and real effects.
 *
 *   1. a tampered index (wrong sha256) is refused, and nothing of it is left;
 *   2. Install Ruby: built and proven; no staging left;
 *   3. as the DEFAULT: `ruby`, `gem` and `bundle` by name are current/ruby/bin; `gem install` puts a gem in place and
 *      its command runs by name; a Gemfile is resolved by `bundle`;
 *   4. listed as managed; Remove deletes it and it is no longer listed.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-ruby.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUBY_RECIPES } from '../src/core/ruby-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { installRubyVersion, listRubyVersions, managedRuby, removeRubyVersion, type RubyVersionsPorts } from '../src/main/ruby-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-ruby-accept-'));
    const toolchainDir = join(base, 'genie2-toolchain');
    const root = join(toolchainDir, 'ruby-versions');
    nodePhpVersionsFs().mkdirp(root);
    const ports: RubyVersionsPorts = {
        platform: 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run, cpus: availableParallelism(),
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = RUBY_RECIPES[0]!.version;

    console.log('1. a tampered index');
    const tampered = await installRubyVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.split('\n').map((l) => { const c = l.split('\t'); if (c.length >= 4 && /^[0-9a-f]{64}$/.test(c[3]!)) c[3] = 'f'.repeat(64); return c.join('\t'); }).join('\n') } : r; } });
    check(tampered.kind === 'not-installed' && /does not match the sha256 ruby-lang\.org publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : JSON.stringify(tampered));
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Build Ruby ${V} from ruby-lang.org's source`);
    const t0 = Date.now();
    const installed = await installRubyVersion(V, true, ports);
    check(installed.kind === 'installed', `built and installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    check(nodePhpVersionsFs().list(root).every((e) => !e.startsWith('.')), 'no staging or tarball left', nodePhpVersionsFs().list(root).join(', '));

    console.log('3. Ruby as the default');
    const linkPorts = { platform: 'linux' as const, toolchainDir, fs: nodeLinkFs('linux') };
    check(setDefault('ruby', V, { ...linkPorts, managed: () => managedRuby(ports).map((m) => m.version) }).kind === 'set', 'setDefault ruby');
    const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: '/usr/bin:/bin', GEM_HOME: join(base, 'gems'), GEM_PATH: join(base, 'gems') };
    restoreDefaultsEnv({ ...linkPorts, env: { get: (n) => env[n], set: (n, v) => { env[n] = v; } } });
    env.PATH = `${join(base, 'gems', 'bin')}:${env.PATH}`;
    const sh = (cmd: string) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env }).trim();
    check(sh('command -v ruby') === join(toolchainDir, 'current', 'ruby', 'bin', 'ruby'), '`ruby` by name is current/ruby/bin/ruby', sh('command -v ruby'));
    check(sh('ruby -v').startsWith(`ruby ${V} `), '`ruby -v` by name names it', sh('ruby -v'));
    sh('gem install --no-document rake -v 13.3.1 >/dev/null 2>&1 || gem install --no-document rake >/dev/null');
    check(/^rake, version \d/.test(sh('rake --version')), 'a gem installed by `gem` runs by name', sh('rake --version'));
    const app = mkdtempSync(join(tmpdir(), 'genie-ruby-app-'));
    writeFileSync(join(app, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rake'\n");
    const bundled = sh(`cd ${app} && bundle install --quiet && bundle exec ruby -e 'require "rake"; print Rake::VERSION'`);
    check(/^\d+\.\d+/.test(bundled), '`bundle install` + `bundle exec` resolve and load a Gemfile', bundled);
    check(setDefault('ruby', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

    console.log('4. list and Remove');
    check((await listRubyVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removeRubyVersion(V, ports).kind === 'removed' && !(await listRubyVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
