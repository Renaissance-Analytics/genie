// VM-only native npm/PHP metadata calls. No provider/model turn, login, network request or global package install.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { childEnv } from '@particle-academy/prism-acp';
import { providerLaunchOptions } from '../../src/main/session-host.js';

assert.equal(process.platform, 'linux', 'use the Linux test VM for case-sensitive npm environment precedence');
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
    .find((path): path is string => typeof path === 'string' && path.endsWith('npm-cli.js') && existsSync(path));
assert(npmCli, 'installed native npm CLI is present');
const php = execFileSync('mise', ['which', 'php'], { encoding: 'utf8' }).trim();
const dir = mkdtempSync(join(tmpdir(), 'genie-provider-toolchain-'));
const managed = join(dir, 'npm-global'); const foreign = join(dir, 'foreign-npx-prefix'); const nodeDir = join(dir, 'node'); const ini = join(dir, 'php-conf');
for (const path of [managed, foreign, nodeDir, ini]) mkdirSync(path);
writeFileSync(join(ini, 'zz-fixture.ini'), 'user_agent="genie-toolchain-fixture"\n', { mode: 0o600 });
const keys = ['PATH', 'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'PHP_INI_SCAN_DIR', 'UNRELATED_PARENT_SECRET'];
const before = new Map(keys.map((name) => [name, process.env[name]]));
const npmPrefix = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [npmCli, 'prefix', '-g'], { encoding: 'utf8', env, timeout: 20_000 }).trim();
const phpMarker = (env: NodeJS.ProcessEnv) => execFileSync(php, ['-r', 'echo ini_get("user_agent");'], { encoding: 'utf8', env, timeout: 20_000 }).trim();
try {
    process.env.PATH = [nodeDir, managed, process.env.PATH ?? ''].join(delimiter);
    delete process.env.NPM_CONFIG_PREFIX; delete process.env.npm_config_prefix;
    process.env.NPM_CONFIG_PREFIX = managed;
    const upperOnly = { ...process.env };
    assert.equal(npmPrefix(upperOnly), managed, 'native npm accepts uppercase prefix');
    delete process.env.NPM_CONFIG_PREFIX; process.env.npm_config_prefix = foreign;
    assert.equal(npmPrefix(process.env), foreign, 'native npm accepts lowercase prefix');
    // Measure both insertion orders rather than assuming which spelling npm chooses on this version.
    const raw = { ...upperOnly, npm_config_prefix: foreign };
    const reversed = { ...process.env, NPM_CONFIG_PREFIX: managed };
    const rawPrefix = npmPrefix(raw); const reversedPrefix = npmPrefix(reversed);
    assert([managed, foreign].includes(rawPrefix) && [managed, foreign].includes(reversedPrefix));
    console.log(JSON.stringify({ npm: execFileSync(process.execPath, [npmCli, '-v'], { encoding: 'utf8' }).trim(), upperThenLower: rawPrefix === managed ? 'upper' : 'lower', lowerThenUpper: reversedPrefix === managed ? 'upper' : 'lower' }));
    delete process.env.NPM_CONFIG_PREFIX; delete process.env.npm_config_prefix;
    process.env.NPM_CONFIG_PREFIX = managed; process.env.npm_config_prefix = foreign;
    process.env.PHP_INI_SCAN_DIR = `${delimiter}${ini}`;
    process.env.UNRELATED_PARENT_SECRET = 'fixture-not-for-provider';
    assert.equal(phpMarker(process.env), 'genie-toolchain-fixture', 'native PHP scan-directory presence control');
    const launch = providerLaunchOptions(undefined, {}, { execPath: process.execPath, electron: false });
    const child = childEnv(launch.parentEnv ?? process.env, launch.allowEnv ? { allow: launch.allowEnv } : {}).env;
    assert.equal(npmPrefix(child), managed, 'SDK child uses the host npm prefix');
    assert.deepEqual(Object.keys(child).filter((name) => name.toUpperCase() === 'NPM_CONFIG_PREFIX'), ['NPM_CONFIG_PREFIX']);
    assert.equal(phpMarker(child), 'genie-toolchain-fixture', 'SDK child loads the repaired PHP ini scan directory');
    assert.equal(child.PATH, process.env.PATH, 'SDK child keeps managed Node/global-bin PATH ordering');
    assert.equal(child.UNRELATED_PARENT_SECRET, undefined, 'unrelated parent secret stays withheld');
    console.log('PASS actual SDK child env, native npm prefix and PHP ini marker; managed values survive without unrelated secrets.');
} finally {
    for (const [name, value] of before) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(dir, { recursive: true, force: true }); // This fresh Linux-only fixture directory, never a user config.
}
