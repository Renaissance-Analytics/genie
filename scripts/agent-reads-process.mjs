/** Direct Node boundary for paired measurement children (Tynn #564). The executable job adopts this explicitly. */
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

const IDENTITY_FIELDS = ['build', 'vmId', 'platform', 'runId'];

/** Only the nonce is supplied by the job: checkout, machine and platform are read by the process itself. */
export function readMeasurementIdentity(runId) {
    if (typeof runId !== 'string' || runId.length === 0) throw new Error('missing measurement run identity');
    const build = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
    const vmId = hostname();
    if (!/^[a-f0-9]{40,64}$/i.test(build) || typeof vmId !== 'string' || vmId.length === 0) throw new Error('could not read measurement build/VM identity');
    return { build, vmId, platform: process.platform, runId };
}

export async function runMeasurementProcess({ request, cwd, out, timeoutMs = 20 * 60_000 }) {
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
        const child = spawn(process.execPath, [resolve(checkout, 'scripts/agent-reads-measure.mjs'), `--mode=${context.mode}`, `--out=${output}`], {
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
