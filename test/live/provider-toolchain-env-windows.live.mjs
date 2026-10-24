// VM-only. A real Codex app-server starts a local stdio MCP fixture; no prompt or login.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexDriver } from '@particle-academy/prism-acp';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GENIE_VM_TOOLCHAIN_PROBE, '1', 'run inside the Windows test VM');
const { providerLaunchOptions } = await import(pathToFileURL(resolve(process.argv[2])).href);
const binary = resolve(process.argv[3]);
console.log(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim());
const root = await mkdtemp(join(tmpdir(), 'genie-provider-env-'));
const project = join(root, 'project'); const home = join(root, 'codex');
await mkdir(join(project, '.git'), { recursive: true }); await mkdir(home);
const prefix = join(root, 'npm-global'); const phpScan = `;${join(root, 'php-conf')}`;
process.env.NPM_CONFIG_PREFIX = prefix;
process.env.PHP_INI_SCAN_DIR = phpScan;
process.env.UNRELATED_PARENT_SECRET = 'fixture-must-not-pass';
const marker = join(project, 'env-seen.json'); const fixture = join(project, 'mcp.mjs');
await writeFile(fixture, `import {writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';writeFileSync(${JSON.stringify(marker)},JSON.stringify({prefix:process.env.NPM_CONFIG_PREFIX??null,php:process.env.PHP_INI_SCAN_DIR??null,secret:process.env.UNRELATED_PARENT_SECRET??null}));createInterface({input:process.stdin}).on('line',l=>{const f=JSON.parse(l);if(f.id===undefined)return;const result=f.method==='initialize'?{protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'env-fixture',version:'1'}}:f.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result})+'\\n');});`);
await writeFile(join(home, 'config.toml'), `model="fixture"\nmodel_provider="fixture"\n[features]\nshell_snapshot=false\n[analytics]\nenabled=false\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n[mcp_servers.env_fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(fixture)}]\nenv_vars=["NPM_CONFIG_PREFIX","PHP_INI_SCAN_DIR","UNRELATED_PARENT_SECRET"]\n`, { mode: 0o600 });
const launch = providerLaunchOptions(binary, {}, { execPath: process.execPath, electron: false });
// Deliberate per-probe bypass: leave the values present in parentEnv, but drop the allow-list additions.
if (process.env.GENIE_VM_TOOLCHAIN_BYPASS === '1') launch.allowEnv = [];
const failures = [];
const driver = new CodexDriver({ ...launch, cwd: project, parentEnv: { ...(launch.parentEnv ?? process.env), CODEX_HOME: home } }, { onProtocolError: (problem) => failures.push(problem) });
const bounded = (promise) => { let timer; return Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error('Codex startup timeout')), 60000); })]).finally(() => clearTimeout(timer)); };
try {
    driver.start(); await bounded(driver.ready);
    const deadline = Date.now() + 20000;
    let seen;
    while (!seen) {
        try { seen = JSON.parse(await readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!seen) { assert(Date.now() < deadline, 'real Codex starts the local MCP fixture'); await delay(25); }
    }
    assert.equal(seen.prefix, prefix, 'real Codex child inherits Genie NPM_CONFIG_PREFIX');
    assert.equal(seen.php, phpScan, 'real Codex child inherits Genie PHP_INI_SCAN_DIR');
    assert.equal(seen.secret, null, 'real Codex child withholds unrelated parent secret');
    assert.deepEqual(failures, [], 'no Codex protocol failure');
    console.log('PASS real Windows Codex inherits both exact toolchain variables; unrelated parent secret withheld; no model prompt or login.');
} finally {
    const stopped = await driver.stop({ graceMs: 0 });
    assert.equal(stopped.empty, true, 'owned Codex/MCP process tree is empty');
    // Leave the fresh VM-only fixture for failed-run diagnosis; the runner restores its snapshot next run.
}
