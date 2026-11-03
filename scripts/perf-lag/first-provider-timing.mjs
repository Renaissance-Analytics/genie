#!/usr/bin/env node
/**
 * WHERE THE 6 TO 10 SECONDS TO AN AGENT'S FIRST PROVIDER GO, on Windows (the runner measured 6,122 and 9,637 ms from start to driver). Run it on genie-test-windows: the runner is an
 * Administrator and differs. It changes nothing in the product, and writes only to a temp folder.
 *
 *   npm ci && node node_modules/electron/install.js
 *   node scripts/perf-lag/first-provider-timing.mjs
 *
 * It runs under Electron's own Node, as genie-host does, and wraps child_process so every native launch is timed and named. What it measures:
 *   - process-table: one reading of the machine, the reading each spawn waits on (it does not hold up the driver, but it is shown beside it);
 *   - acl: writePrivateCredential on its own: first in a new folder (cold), again in that folder, and a first in a second folder;
 *   - prepare: the host's whole preparation of an agent with Tynn unreachable and a keychain that answers, as in test/host-tynn-recovery.test.ts: the first agent, and a second.
 *
 * Prints `### first-provider <step>=<ms>  detail` and one `--- launch <ms> <program> ...` per native launch (arguments cut, no paths or secrets beyond the temp folder).
 * Compare `prepare-first-agent` with the launches inside it: most of it in `powershell` or `icacls` means the ACL.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.FIRST_PROVIDER_CHILD) {
    const require = createRequire(import.meta.url);
    const dir = mkdtempSync(join(tmpdir(), 'first-provider-'));
    let status = 1;
    try {
        const out = join(dir, 'bundle.mjs');
        require('esbuild').buildSync({
            stdin: {
                contents: "export { writePrivateCredential } from './src/main/private-credentials.ts'; export { hostAgentKeys } from './src/main/host-agent-keys.ts'; export { systemProcessTree } from './src/core/process-tree.ts'; export { agentRecord, mintAgentId } from './src/core/identity.ts';",
                resolveDir: join(here, '..', '..'), loader: 'ts',
            },
            bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', external: ['@napi-rs/keyring'],
            banner: { js: "import { createRequire as firstProviderRequire } from 'node:module'; const require = firstProviderRequire(import.meta.url);" },
        });
        const child = spawnSync(require('electron'), [fileURLToPath(import.meta.url)], {
            encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FIRST_PROVIDER_CHILD: pathToFileURL(out).href, FIRST_PROVIDER_DIR: dir },
        });
        process.stdout.write(child.stdout ?? '');
        process.stderr.write(child.stderr ?? '');
        status = child.status ?? 1;
        if (child.status === null) console.log(`### first-provider=FAIL  the child did not finish: ${child.signal ?? child.error?.message ?? 'unknown'}`);
    } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    process.exit(status);
}

// Before the bundle loads: it binds execFile at import.
const cp = createRequire(import.meta.url)('node:child_process');
const util = createRequire(import.meta.url)('node:util');
const launches = [];
const shown = (file, args) => `${String(file).split(/[\\/]/).pop()} ${(Array.isArray(args) ? args : []).join(' ').slice(0, 60)}`;
const realExecFile = cp.execFile;
const realPromisified = util.promisify(realExecFile);
const timed = (file, args, ...rest) => {
    const began = performance.now();
    const child = realExecFile(file, args, ...rest);
    child.once('close', () => { const ms = Math.round(performance.now() - began); launches.push(ms); console.log(`--- launch ${ms} ${shown(file, args)}`); });
    return child;
};
timed[util.promisify.custom] = (file, args, ...rest) => {
    const began = performance.now();
    const done = () => { const ms = Math.round(performance.now() - began); launches.push(ms); console.log(`--- launch ${ms} ${shown(file, args)}`); };
    const promise = realPromisified(file, args, ...rest);
    promise.then(done, done);
    return promise;
};
cp.execFile = timed;
syncBuiltinESMExports();

const { writePrivateCredential, hostAgentKeys, systemProcessTree, agentRecord, mintAgentId } = await import(process.env.FIRST_PROVIDER_CHILD);
const dir = process.env.FIRST_PROVIDER_DIR;
const failures = [];
const step = async (name, run) => {
    const before = launches.length;
    const began = performance.now();
    try {
        await run();
        const here2 = launches.slice(before);
        console.log(`### first-provider ${name}=${Math.round(performance.now() - began)}  ${here2.length} native launch(es), ${here2.reduce((a, b) => a + b, 0)} ms in them`);
    } catch (error) {
        failures.push(name);
        console.log(`### first-provider ${name}=FAIL  after ${Math.round(performance.now() - began)} ms: ${error instanceof Error ? error.message : String(error)}`);
    }
};
console.log(`--- node ${process.versions.node} electron ${process.versions.electron ?? 'none'} ${process.platform}`);

await step('process-table-1', () => systemProcessTree.read());
await step('process-table-2', () => systemProcessTree.read());

await step('acl-first-file-in-a-new-folder', () => writePrivateCredential(join(dir, 'one', 'agents.json'), '{}'));
await step('acl-same-file-again', () => writePrivateCredential(join(dir, 'one', 'agents.json'), '{"a":1}'));
await step('acl-first-file-in-a-second-folder', () => writePrivateCredential(join(dir, 'two', 'agents.json'), '{}'));

const fakeKeychain = () => {
    const held = new Map();
    return {
        probe: async () => ({ ok: true }),
        get: async (name) => { const value = held.get(name); return value === undefined ? { kind: 'missing' } : { kind: 'value', value }; },
        set: async (name, value) => { held.set(name, value); return { ok: true }; },
        delete: async (name) => { held.delete(name); return { ok: true }; },
    };
};
const { writeFileSync, mkdirSync } = await import('node:fs');
const workspace = join(dir, 'workspace');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'project.json'), JSON.stringify({ tynn: { projectId: 'project-42' } }));
const unreachable = {
    status: () => ({ signedIn: true }), userId: () => 'user-7', savedUserId: () => 'user-7',
    request: async () => { throw new Error('Tynn could not be reached.'); },
};
const keys = hostAgentKeys({ vaultFile: join(dir, 'agent-credentials', 'agents.json'), keychain: fakeKeychain(), tynn: () => unreachable, workspaces: () => [{ id: 'ws', path: workspace }] });
const agent = () => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas' });
await step('prepare-first-agent', () => keys(agent(), workspace));
await step('prepare-second-agent', () => keys(agent(), workspace));

console.log(`### first-provider=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
