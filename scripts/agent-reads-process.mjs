/** Direct Node boundary for paired measurement children (Tynn #564). The executable job adopts this explicitly. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const IDENTITY_FIELDS = ['build', 'vmId', 'platform', 'runId'];

/** Azure ships source without .git. Hash the actual complete app, including preloads in dist/main, not a claimed SHA. */
function artifactFingerprint() {
    const root = process.cwd(), files = [];
    const walk = (directory, depth = 0) => {
        const stat = lstatSync(directory);
        if (stat.isSymbolicLink()) throw new Error(`linked artifact directory: ${directory}`);
        if (!stat.isDirectory() || depth > 32) throw new Error(`invalid artifact directory: ${directory}`);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`linked artifact: ${path}`);
            if (entry.isDirectory()) walk(path, depth + 1);
            else if (entry.isFile()) files.push(path);
            else throw new Error(`unsupported artifact: ${path}`);
            if (files.length > 10_000) throw new Error('artifact file count exceeds its bound');
        }
    };
    try {
        walk(resolve(root, 'dist/main'));
        walk(resolve(root, 'dist/renderer'));
        files.push(resolve(root, 'package.json'), resolve(root, 'package-lock.json'));
        const names = new Set(files.map((file) => relative(root, file).split(sep).join('/')));
        for (const required of ['dist/main/entry.js', 'dist/main/host.js', 'dist/main/preload.cjs', 'dist/renderer/index.html']) {
            if (!names.has(required)) throw new Error(`missing required artifact: ${required}`);
        }
        const hash = createHash('sha256');
        let totalBytes = 0;
        for (const file of files.sort()) {
            const stat = lstatSync(file);
            if (stat.isSymbolicLink()) throw new Error(`linked artifact: ${file}`);
            if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error(`invalid or oversized artifact: ${file}`);
            const bytes = readFileSync(file);
            totalBytes += bytes.length;
            if (bytes.length > 128 * 1024 * 1024 || totalBytes > 512 * 1024 * 1024) throw new Error('artifact bytes exceed their bound');
            // Explicit path and byte-length framing prevents path/content boundary ambiguity.
            hash.update(`${JSON.stringify([relative(root, file).split(sep).join('/'), bytes.length])}\n`);
            hash.update(bytes);
        }
        return `artifact-sha256:${hash.digest('hex')}`;
    } catch (error) { throw new Error(`artifact identity unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Only the nonce is supplied by the job: checkout, machine and platform are read by the process itself. */
export function readMeasurementIdentity(runId) {
    if (typeof runId !== 'string' || runId.length === 0) throw new Error('missing measurement run identity');
    let build;
    try { build = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { build = artifactFingerprint(); }
    const vmId = hostname();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64}|artifact-sha256:[a-f0-9]{64})$/i.test(build) || typeof vmId !== 'string' || vmId.length === 0) throw new Error('could not read measurement build/VM identity');
    return { build, vmId, platform: process.platform, runId };
}

export async function runMeasurementProcess({ request, cwd, out, timeoutMs = 20 * 60_000, scope = 'full' }) {
    if (!['full', 'm4-diagnostic'].includes(scope)) throw new Error('unknown measurement scope');
    const context = structuredClone(request);
    if (!['ipc', 'door', 'door-revision'].includes(context?.mode) || !Number.isSafeInteger(context.pairIndex) || context.pairIndex < 0) throw new Error('invalid sample request mode or pair index');
    for (const field of IDENTITY_FIELDS) {
        if (typeof context.identity?.[field] !== 'string' || context.identity[field].length === 0) throw new Error(`missing sample identity: ${field}`);
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('sample deadline must be a positive integer');
    if (typeof cwd !== 'string' || cwd.length === 0 || typeof out !== 'string' || out.length === 0) throw new Error('sample checkout and output paths are required');
    const checkout = resolve(cwd), output = resolve(out);
    const env = { ...process.env, AGENT_READS_REQUEST: JSON.stringify(context) };
    // The requested mode belongs to this sample, never an inherited switch left by a previous run.
    delete env.GENIE_AGENT_READS;
    delete env.GENIE_SNAPSHOT_PUSH;
    delete env.AGENT_READS_PROBE_ONLY;

    const samplerPid = await new Promise((accept, reject) => {
        const args = [resolve(checkout, 'scripts/agent-reads-measure.mjs'), `--mode=${context.mode}`, `--out=${output}`];
        if (scope !== 'full') args.push(`--scope=${scope}`);
        const child = spawn(process.execPath, args, {
            cwd: checkout, shell: false, env, stdio: ['ignore', 'inherit', 'inherit'],
            detached: process.platform !== 'win32', windowsHide: true,
        });
        const pid = child.pid;
        let settled = false, timer;
        const fail = (error) => {
            if (settled) return;
            settled = true; clearTimeout(timer); reject(error);
        };
        child.once('error', fail);
        child.once('close', (code, signal) => {
            if (settled) return;
            if (code !== 0 || signal) { fail(new Error(`sampler exit code ${code}, signal ${signal ?? 'none'}`)); return; }
            if (!Number.isSafeInteger(pid) || pid < 1) { fail(new Error('sampler exited without an owned PID')); return; }
            settled = true; clearTimeout(timer); accept(pid);
        });
        timer = setTimeout(() => {
            if (settled) return;
            // Claim the timeout before terminating: a synchronous close cannot turn it into successful acquisition.
            settled = true;
            let cleanupError = '';
            try {
                if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('no owned sampler PID');
                if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
                else process.kill(-pid, 'SIGKILL'); // spawn detached above: this is the sampler's own process group.
            } catch (error) { cleanupError = `; process termination failed: ${error instanceof Error ? error.message : String(error)}`; }
            reject(new Error(`sampler deadline exceeded after ${timeoutMs} ms${cleanupError}`));
        }, timeoutMs);
    });

    // Never read evidence before exit, or accept a successful-looking file after an unsuccessful exit.
    const sample = JSON.parse(await readFile(output, 'utf8'));
    if ((sample?.scope ?? 'full') !== scope) throw new Error('sampler scope does not match full/diagnostic request');
    if (sample?.finished !== true) throw new Error('unfinished sample result');
    if (sample.cleanup?.complete !== true) throw new Error('sample process cleanup is not confirmed');
    if (!Array.isArray(sample.failures) || sample.failures.length !== 0) throw new Error('sample recorded failed or missing checks');
    if (sample.samplerPid !== samplerPid) throw new Error('sample result belongs to another sampler PID');
    for (const field of IDENTITY_FIELDS) {
        if (sample.identity?.[field] !== context.identity[field]) throw new Error(`sample identity mismatch: ${field}`);
    }
    if (sample.mode !== context.mode || sample.pairIndex !== context.pairIndex) throw new Error('sample mode or pair index does not match its request');
    return sample;
}
