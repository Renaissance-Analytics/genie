import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchProvider, prepareProcessTree } from '@particle-academy/prism-acp';

/**
 * THE WINDOWS SUPERVISOR: A COLD MACHINE, SEVERAL AGENTS AT ONCE, AND AN UPGRADED INSTALL (prism-acp 0.32.0).
 *
 * On Windows prism-acp contains every provider in a Job Object through a small supervisor it COMPILES on first use
 * (csc.exe) and hash-checks at every launch; since 0.30.0 the same executable is also the exit adapter of a Claude
 * agent's approval hook. Genie keeps it in its own runtime folder: main.ts calls
 * `prepareProcessTree({ directory: <genieHome>/runtime/prism-supervisor })` before any agent starts. Without that
 * override prism-acp would use %LOCALAPPDATA%/prism-acp/supervisor-<source hash>. Every test here hands prism-acp a
 * fresh temp folder the way main.ts hands it Genie's, so nothing touches the machine's real supervisor cache.
 *
 * Measured on genie-test-windows (2026-10-26), against prism-acp 0.31.0:
 *  - Cold start, 8 agents at once, in ONE process and in 8 processes released at one instant: every launch started,
 *    in 6 runs. Genie builds the supervisor once at boot, and every launch after that is synchronous in one process,
 *    so the cross-process build race prism-acp 0.32.0 fixes ("the supervisor does not match the hash recorded when it
 *    was built") has no second builder to race in Genie, and was not reproduced here. These two stay as the regression.
 *  - The UPGRADED install failed, 3 runs of 3: `approvalExit: 125`. Genie's folder is not keyed by the supervisor's
 *    source, so a Genie that had run prism-acp 0.29 or older kept that build, and on 0.30/0.31 the old supervisor —
 *    still matching its own recorded hash — became the approval adapter. It has no approval mode, so every gated tool
 *    call of a Claude agent was blocked. 0.32.0 keeps builds under their digest behind a pointer file an older release
 *    never wrote, so the first launch on 0.32.0 rebuilds from the current source.
 */

const AGENTS = 8;
/** A provider that starts and ends: the question is whether prism-acp's containment lets it start at all. */
const PROVIDER_ARGS = ['-e', 'setTimeout(() => process.exit(0), 200)'];

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-cold-supervisor-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

async function startAndEnd(cwd: string): Promise<string> {
    const provider = launchProvider(process.execPath, PROVIDER_ARGS, { cwd, env: { ...process.env } });
    const tree = await provider.started;
    const verdict = await provider.stop({ graceMs: 2_000 });
    return `${tree.containment.kind}:${verdict.verified}`;
}

/** The .NET Framework compiler prism-acp builds with. */
function csc(): string {
    const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:/Windows';
    const found = ['Framework64', 'Framework'].map((bits) => join(windows, 'Microsoft.NET', bits, 'v4.0.30319', 'csc.exe')).find((p) => existsSync(p));
    if (!found) throw new Error('csc.exe not found');
    return found;
}

describe.skipIf(process.platform !== 'win32')('the Windows supervisor', () => {
    it(`a cold machine: one Genie starts ${AGENTS} agents at once, every one contained`, async () => {
        const folder = join(dir, 'prism-supervisor');
        expect(existsSync(folder)).toBe(false);
        await prepareProcessTree({ directory: folder });
        const results = await Promise.allSettled(Array.from({ length: AGENTS }, () => startAndEnd(dir)));
        const refused = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
        expect(refused).toEqual([]);
        expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual(Array(AGENTS).fill('job-object:true'));
    }, 120_000);

    it(`a cold machine: ${AGENTS} processes make their first launch at the same instant into one folder, and every one starts`, async () => {
        const folder = join(dir, 'prism-supervisor');
        // Each child is Genie's boot path in miniature: prepare the supervisor in the shared folder, then start one agent.
        // They load prism-acp first and wait for one shared instant, so the builds overlap as tightly as they can.
        const prism = import.meta.resolve('@particle-academy/prism-acp');
        const startAt = Date.now() + 4_000;
        const child = [
            `const { prepareProcessTree, launchProvider } = await import(${JSON.stringify(prism)});`,
            `while (Date.now() < ${startAt}) {}`,
            'try {',
            `  await prepareProcessTree({ directory: ${JSON.stringify(folder)} });`,
            `  const p = launchProvider(process.execPath, ${JSON.stringify(PROVIDER_ARGS)}, { cwd: process.cwd(), env: { ...process.env } });`,
            '  const tree = await p.started;',
            '  const verdict = await p.stop({ graceMs: 2000 });',
            '  process.stdout.write(`started ${tree.containment.kind} ${verdict.verified}`);',
            '} catch (error) { process.stdout.write(`refused ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }',
        ].join('\n');
        const run = () => new Promise<string>((resolve) => {
            execFile(process.execPath, ['--input-type=module', '-e', child], { cwd: dir, timeout: 90_000, windowsHide: true }, (error, stdout, stderr) => {
                resolve(stdout.trim() || `failed ${error?.message ?? ''} ${stderr}`.trim());
            });
        });
        const outcomes = await Promise.all(Array.from({ length: AGENTS }, run));
        expect(outcomes.filter((o) => o !== 'started job-object true')).toEqual([]);
        // The positive control for "cold": the folder did not exist before this test, and these launches built it.
        expect((await readdir(folder)).some((name) => name.startsWith('prism-acp-supervisor'))).toBe(true);
    }, 120_000);

    it('an install upgraded from prism-acp 0.29: the supervisor Genie runs is the current one, and a Claude approval passes through it', async () => {
        // What a Genie on prism-acp 0.29 or older left in its runtime folder: that release's supervisor, built the way it
        // built it (csc; `prism-acp-supervisor.exe` beside its `.sha256`).
        const folder = join(dir, 'prism-supervisor');
        await mkdir(folder, { recursive: true });
        const old = join(folder, 'prism-acp-supervisor.exe');
        const source = fileURLToPath(new URL('./fixtures/prism-acp-0.29-supervisor.cs', import.meta.url));
        execFileSync(csc(), ['-nologo', '-optimize+', '-target:exe', `-out:${old}`, source], { stdio: 'ignore', windowsHide: true });
        const oldHash = createHash('sha256').update(readFileSync(old)).digest('hex');
        await writeFile(`${old}.sha256`, oldHash);

        // Genie boots on the new prism-acp and starts an agent.
        await prepareProcessTree({ directory: folder });
        const provider = launchProvider(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], { cwd: dir, env: { ...process.env } });
        const tree = await provider.started;
        const image = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${tree.supervisorPid}).Path`], { encoding: 'utf8', windowsHide: true }).trim();
        await provider.stop({ graceMs: 2_000 });
        // The positive control for the read: the image is an executable in Genie's folder.
        expect(image.toLowerCase().startsWith(folder.toLowerCase())).toBe(true);

        // A Claude agent's approval hook runs `<supervisor> approval <node> <hook> node`; the hook exits 42 to allow, and
        // the adapter must turn that into 0. A supervisor without the approval mode blocks the call (0.29's exits 125).
        const hook = join(dir, 'allow.cjs');
        await writeFile(hook, 'process.exit(42)');
        const approval = spawnSync(image, ['approval', process.execPath, hook, 'node'], { input: '{}', windowsHide: true, timeout: 30_000 });
        expect({ approvalExit: approval.status, stderr: String(approval.stderr ?? '').trim() }).toEqual({ approvalExit: 0, stderr: '' });
        expect(createHash('sha256').update(readFileSync(image)).digest('hex')).not.toBe(oldHash);
    }, 120_000);
});

/**
 * GENIE'S OWN FOLDER, KEYED BY THE SOURCE (genie#1259). The upgrade case above passes on prism-acp 0.32.0 only because
 * 0.32 moved to a layout no earlier release wrote. Here the old build is IN the 0.32 layout — what the next release that
 * changes SUPERVISOR_CS would find — and Genie's boot step (src/main/prism-supervisor.ts, as main.ts calls it) must still
 * not run it.
 */
describe.skipIf(process.platform !== 'win32')('the Windows supervisor, in Genie’s keyed folder', () => {
    /** The 0.29 supervisor, built once (csc's output differs build to build, so one build serves every folder). */
    function oldBuild(): { exe: string; hash: string } {
        const exe = join(dir, 'old-build.exe');
        const source = fileURLToPath(new URL('./fixtures/prism-acp-0.29-supervisor.cs', import.meta.url));
        execFileSync(csc(), ['-nologo', '-optimize+', '-target:exe', `-out:${exe}`, source], { stdio: 'ignore', windowsHide: true });
        return { exe, hash: createHash('sha256').update(readFileSync(exe)).digest('hex') };
    }
    /** That build placed in `folder` in prism-acp 0.32's layout: the build under its digest plus the pointer naming it. */
    function oldBuildIn(folder: string, old: { exe: string; hash: string }): void {
        copyFileSync(old.exe, join(folder, `prism-acp-supervisor-${old.hash}.exe`));
        writeFileSync(join(folder, 'prism-acp-supervisor.current.sha256'), old.hash);
    }

    it('a build from another supervisor source, in the current layout, is not reused: the approval passes', async () => {
        const { prepareGenieSupervisor } = await import('../src/main/prism-supervisor.js');
        const runtime = join(dir, 'runtime');
        // Where a Genie before genie#1259 kept it, and under another source key: both hold the 0.29 build, both verify.
        const legacy = join(runtime, 'prism-supervisor');
        const otherKey = join(legacy, 'supervisor-0123456789abcdef');
        await mkdir(otherKey, { recursive: true });
        const old = oldBuild();
        const oldHash = old.hash;
        oldBuildIn(legacy, old);
        oldBuildIn(otherKey, old);

        const folder = await prepareGenieSupervisor(runtime);
        const provider = launchProvider(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], { cwd: dir, env: { ...process.env } });
        const tree = await provider.started;
        const image = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${tree.supervisorPid}).Path`], { encoding: 'utf8', windowsHide: true }).trim();
        await provider.stop({ graceMs: 2_000 });
        expect(image.toLowerCase().startsWith(folder.toLowerCase())).toBe(true);

        const hook = join(dir, 'allow.cjs');
        await writeFile(hook, 'process.exit(42)');
        const approval = spawnSync(image, ['approval', process.execPath, hook, 'node'], { input: '{}', windowsHide: true, timeout: 30_000 });
        expect({ approvalExit: approval.status, stderr: String(approval.stderr ?? '').trim() }).toEqual({ approvalExit: 0, stderr: '' });
        expect(createHash('sha256').update(readFileSync(image)).digest('hex')).not.toBe(oldHash);
    }, 120_000);

    it('Genie’s key is prism-acp’s own: its default folder, built with no override, has the same name', async () => {
        const { supervisorFolder } = await import('../src/main/prism-supervisor.js');
        const local = join(dir, 'localappdata');
        await mkdir(local);
        const prism = import.meta.resolve('@particle-academy/prism-acp');
        // A fresh process: prism-acp keeps an override for the life of the process, and this one must have none.
        execFileSync(process.execPath, ['--input-type=module', '-e', `const { prepareProcessTree } = await import(${JSON.stringify(prism)}); await prepareProcessTree();`], {
            env: { ...process.env, LOCALAPPDATA: local }, stdio: 'ignore', windowsHide: true, timeout: 90_000,
        });
        expect(await readdir(join(local, 'prism-acp'))).toEqual([basename(supervisorFolder(join(dir, 'runtime')))]);
    }, 120_000);

    it('a stale build a process is running from is kept; once it has ended, it is removed', async () => {
        const { removeStaleSupervisorBuilds, supervisorFolder, supervisorImagesRunning } = await import('../src/main/prism-supervisor.js');
        const runtime = join(dir, 'runtime');
        const current = supervisorFolder(runtime);
        const stale = join(runtime, 'prism-supervisor', 'supervisor-0123456789abcdef');
        await mkdir(current, { recursive: true });
        await mkdir(stale, { recursive: true });
        // A real executable, really running from the stale folder (any long-lived image will do: Node itself).
        const image = join(stale, 'held.exe');
        copyFileSync(process.execPath, image);
        const held = spawn(image, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
        try {
            await new Promise<void>((resolve, reject) => { held.once('spawn', () => resolve()); held.once('error', reject); });
            const running = await supervisorImagesRunning();
            // The positive control for the read: the listing can see this very image.
            expect(running?.some((p) => p.toLowerCase() === image.toLowerCase())).toBe(true);
            const sweep = await removeStaleSupervisorBuilds(runtime, { current, runningImages: supervisorImagesRunning });
            expect(sweep.running).toEqual([stale]);
            expect(existsSync(image)).toBe(true);
        } finally {
            held.kill();
            await new Promise((resolve) => (held.exitCode !== null || held.signalCode !== null ? resolve(null) : held.once('exit', resolve)));
        }
        const after = await removeStaleSupervisorBuilds(runtime, { current, runningImages: supervisorImagesRunning });
        expect(after.removed).toEqual([stale]);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(current)).toBe(true);
    }, 120_000);
});
