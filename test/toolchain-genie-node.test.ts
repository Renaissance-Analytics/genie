import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '../src/core/toolchain.js';
import { checkAndRepair, nodeToolchainFs, preferGenieNode, restoreToolchainEnv, type EnvPort, type ToolchainOpsPorts } from '../src/main/toolchain-ops.js';
import type { CommandRunner } from '../src/main/toolchain-prober.js';

/**
 * CHECK AND REPAIR FOR NODE (the owner, 2026-10-23: "we better not be using herds node. genie has its own install path";
 * "the genie should be able to diagnose and resolve toolchain issues"). What this machine had: `node` resolving to Herd's
 * `C:\Program Files\nodejs` (a v24 node.exe beside v22's npm), and `npm` resolving first to a global npm 9.8.0 shim in
 * `AppData\Roaming\npm`. Genie now owns a Node (main/node-versions.ts); the repair makes it the node AND npm Genie's own
 * processes run, MEASURED by `where` afterwards — or says why not. The person's persisted PATH is never written.
 */

const HERD = 'C:\\Program Files\\nodejs';
const ROAMING = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const GENIE = 'C:\\genie2-toolchain\\node-versions\\24.22.1';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'genie2-genie-node-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A Windows machine: what is in each directory, the version each node.exe reports, and whether Genie's own npm runs. */
function rig(opts: { path: string; genie?: { version: string; dir: string } | null; genieNpmRuns?: boolean; platform?: Platform; versions?: Record<string, string> }) {
    const env = new Map<string, string>([['PATH', opts.path]]);
    const files: Record<string, string[]> = { [HERD]: ['node.exe', 'npm.cmd'], [ROAMING]: ['npm.cmd', 'codex.cmd'], [GENIE]: ['node.exe', 'npm.cmd'] };
    const versions: Record<string, string> = { [HERD]: '24.19.0', [GENIE]: '24.22.1', ...opts.versions };
    const calls: string[] = [];
    const run: CommandRunner = async (binary, args) => {
        calls.push(`${binary} ${args.join(' ')}`);
        if (binary === 'where') {
            const name = args[args.length - 1]!;
            const found = (env.get('PATH') ?? '').split(';').filter(Boolean).flatMap((d) => (files[d] ?? []).filter((f) => f === `${name}.exe` || f === `${name}.cmd`).map((f) => `${d}\\${f}`));
            return found.length > 0 ? { stdout: found.join('\r\n'), exitCode: 0 } : { stdout: 'INFO: Could not find files for the given pattern(s).', exitCode: 1 };
        }
        const dir = binary.slice(0, binary.lastIndexOf('\\'));
        if (binary.endsWith('node.exe') && args.some((a) => a.endsWith('npm-cli.js'))) return dir === GENIE && opts.genieNpmRuns === false ? { stdout: 'TypeError: Class extends value undefined', exitCode: 1 } : { stdout: '11.19.1', exitCode: 0 };
        if (binary.endsWith('node.exe') && versions[dir]) return { stdout: `v${versions[dir]}`, exitCode: 0 };
        throw Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    };
    const envPort: EnvPort = { get: (n) => env.get(n), set: (n, v) => { env.set(n, v); } };
    const genie = opts.genie === undefined ? { version: '24.22.1', dir: GENIE } : opts.genie;
    const ports: ToolchainOpsPorts = {
        platform: opts.platform ?? 'win32', run, env: envPort, fs: nodeToolchainFs(), dataDir: join(root, 'genie2-toolchain'),
        // A System32 path that does not exist would raise a vc-runtime finding; this suite is about node, so only node findings are read.
        systemRoot: 'C:\\Windows', packageManager: async () => 'winget', now: () => 1_000,
        genieNode: () => genie,
    };
    return { ports, env, calls };
}

const nodeFindings = async (ports: ToolchainOpsPorts) => (await checkAndRepair(ports)).findings.filter((f) => f.kind === 'genie-node' || (f.kind === 'path-shadow' && f.tool === 'node'));

describe('Check and repair: the node Genie runs is Genie’s own', () => {
    it('Herd’s node first and a global npm shim first → ONE finding, repaired: Genie’s node AND npm now resolve first, measured', async () => {
        const r = rig({ path: `${ROAMING};${HERD};C:\\Windows` });
        const found = await nodeFindings(r.ports);
        expect(found).toEqual([{ kind: 'genie-node', problem: expect.stringContaining(`${HERD}\\node.exe`), result: { kind: 'repaired', detail: expect.stringContaining(GENIE) } }]);
        expect(found[0]!.kind === 'genie-node' && found[0]!.problem).toMatch(/npm.*Roaming/);
        expect(r.env.get('PATH')!.split(';')[0]).toBe(GENIE);
        // Nobody's entry deleted: the shim directory (codex lives there) is still on PATH.
        expect(r.env.get('PATH')).toContain(ROAMING);
    });

    it('the order is remembered: the next launch puts Genie’s node first before anything spawns', async () => {
        const r = rig({ path: `${HERD};C:\\Windows` });
        await checkAndRepair(r.ports);
        const fresh = new Map<string, string>([['PATH', `${HERD};C:\\Windows`]]);
        restoreToolchainEnv({ platform: 'win32', env: { get: (n) => fresh.get(n), set: (n, v) => { fresh.set(n, v); } }, fs: { ...nodeToolchainFs(), exists: (p) => p === GENIE || nodeToolchainFs().exists(p) }, dataDir: r.ports.dataDir });
        expect(fresh.get('PATH')!.split(';')[0]).toBe(GENIE);
    });

    it('CONTROL: Genie’s node and npm already first → no finding, PATH untouched — even with a NEWER Herd node later (no shadow tug-of-war)', async () => {
        const path = `${GENIE};${HERD};${ROAMING}`;
        const r = rig({ path, versions: { [HERD]: '25.2.1' } });
        expect(await nodeFindings(r.ports)).toEqual([]);
        expect(r.env.get('PATH')).toBe(path);
    });

    it('Genie’s own npm does not run → said, and its node is NOT put first (a broken npm in front is worse)', async () => {
        const path = `${HERD};C:\\Windows`;
        const r = rig({ path, genieNpmRuns: false });
        const found = await nodeFindings(r.ports);
        expect(found).toEqual([{ kind: 'genie-node', problem: expect.any(String), result: { kind: 'unchanged', reason: expect.stringMatching(/npm.*does not run.*Toolchain → Node versions/) } }]);
        expect(r.env.get('PATH')).toBe(path);
    });

    it('Genie manages no Node yet → said where to install one; nothing moved', async () => {
        const path = `${HERD};C:\\Windows`;
        const r = rig({ path, genie: null });
        const found = await nodeFindings(r.ports);
        expect(found).toEqual([{ kind: 'genie-node', problem: expect.stringContaining(HERD), result: { kind: 'unchanged', reason: expect.stringMatching(/Install Node 24\.22\.1 in Toolchain → Node versions/) } }]);
        expect(r.env.get('PATH')).toBe(path);
    });

    it('not on Windows: no genie-node finding (Genie installs its own Node on Windows only)', async () => {
        const r = rig({ path: '/usr/bin', platform: 'linux', genie: null });
        expect((await checkAndRepair(r.ports)).findings.filter((f) => f.kind === 'genie-node')).toEqual([]);
    });
});

describe('after an install', () => {
    it('preferGenieNode puts the installed node first now, and remembers it for the next launch', () => {
        const r = rig({ path: `${HERD};C:\\Windows` });
        preferGenieNode(r.ports, GENIE);
        expect(r.env.get('PATH')!.split(';')[0]).toBe(GENIE);
        const fresh = new Map<string, string>([['PATH', HERD]]);
        restoreToolchainEnv({ platform: 'win32', env: { get: (n) => fresh.get(n), set: (n, v) => { fresh.set(n, v); } }, fs: { ...nodeToolchainFs(), exists: (p) => p === GENIE || nodeToolchainFs().exists(p) }, dataDir: r.ports.dataDir });
        expect(fresh.get('PATH')!.split(';')[0]).toBe(GENIE);
    });
});
