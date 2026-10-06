import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACP_MIN_NODE_MAJOR, nodeMajorOk } from '../agent-spec';

/**
 * The Electron that ships IS the Node that ACP runs on — assert it meets the floor.
 *
 * `main/acp/start.ts` passes `nodeExec: () => process.execPath`, so an ACP agent is hosted
 * by Electron-as-Node. That is deliberate: the pty host's standalone runtime is pinned at
 * **20.20.2** and must never host ACP, because bumping it drags the ABI-matched `node-pty`
 * prebuild along — the coupling that used to kill live terminals on every upgrade.
 *
 * ## Why this test exists
 *
 * Until now the floor was only ever checked AT SPAWN. If an Electron bump (or downgrade)
 * landed a bundled Node below {@link ACP_MIN_NODE_MAJOR}, `nodeMajorOk` would refuse
 * politely and **the whole transport would be dead on arrival** — discovered by whoever
 * first flipped `acp_engine` on, not by the build. Owner direction 2026-10-06: *"we should
 * be building on node 22."* This makes that enforced rather than asserted.
 *
 * ## Why it is safe on the owner's desktop
 *
 * It **cannot run there.** Electron's binary is not downloaded on the owner's machine
 * (`node_modules/electron/dist` is absent), so the guard below skips. In CI the dist exists
 * and the probe runs: `ELECTRON_RUN_AS_NODE=1 … -p process.versions.node` opens no window,
 * starts no pty and exits in milliseconds — the short-lived-child case, not the
 * launch-the-app case the first-tier rule forbids.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** The real executable, read from Electron's own `path.txt`. No guessing at layout. */
function electronBinary(): string | null {
    const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
    const pointer = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
    if (!fs.existsSync(dist) || !fs.existsSync(pointer)) return null;
    const exe = path.join(dist, fs.readFileSync(pointer, 'utf8').trim());
    return fs.existsSync(exe) ? exe : null;
}

/**
 * Ask a Node-compatible binary for its Node version.
 *
 * Extracted so the PARSING and FAILURE handling are exercised on every machine, against
 * this process's own `node`. Otherwise the only code path that matters would run for the
 * first time in CI — untested in exactly the way that counts.
 */
export function nodeVersionOf(exe: string): { ok: true; version: string } | { ok: false; why: string } {
    const probe = spawnSync(exe, ['-p', 'process.versions.node'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 30_000,
    });
    if (probe.error) return { ok: false, why: `did not run: ${probe.error.message}` };
    if (probe.status !== 0) return { ok: false, why: `exited ${probe.status}: ${probe.stderr}` };
    const version = probe.stdout.trim();
    // A probe that ran but answered nothing must NOT read as a pass.
    if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, why: `unparseable: ${JSON.stringify(version)}` };
    return { ok: true, version };
}

describe('the probe itself, exercised against the node running this suite', () => {
    it('reads a version from a real binary', () => {
        // process.execPath IS node here, and behaves identically under the flag.
        const got = nodeVersionOf(process.execPath);
        expect(got.ok, got.ok ? '' : got.why).toBe(true);
        if (!got.ok) return;
        expect(got.version).toBe(process.versions.node);
    });

    it('reports a binary that is not there, instead of returning a blank version', () => {
        const got = nodeVersionOf(path.join(ROOT, 'no', 'such', 'binary'));
        expect(got.ok).toBe(false);
        if (got.ok) return;
        expect(got.why).toMatch(/did not run|exited/);
    });

    it('agrees with the floor check on this machine', () => {
        // Ties the two halves together: whatever node is running this suite must itself
        // clear the floor, since we build on 22.
        const got = nodeVersionOf(process.execPath);
        expect(got.ok).toBe(true);
        if (!got.ok) return;
        expect(nodeMajorOk(got.version)).toBe(true);
    });
});

describe('the floor itself', () => {
    it('is 22, and is the number the owner named', () => {
        // Pinned as a value so relaxing it is a visible edit rather than a drift. A
        // dependency declaring a LOWER floor is read as permission by whoever reconciles
        // two manifests next — which is exactly how this would end up on 20.20.2.
        expect(ACP_MIN_NODE_MAJOR).toBe(22);
    });

    it('refuses 20, which is the runtime ACP must never use', () => {
        expect(nodeMajorOk('v20.20.2')).toBe(false);
        expect(nodeMajorOk('v22.0.0')).toBe(true);
    });

    it('refuses a version it cannot parse, rather than assuming it is fine', () => {
        expect(nodeMajorOk('weird')).toBe(false);
    });
});

describe("the shipped Electron's bundled Node", () => {
    const exe = electronBinary();

    it.skipIf(exe === null)('meets the ACP floor', () => {
        // Guarded above: absent on the owner's desktop, present in CI.
        const got = nodeVersionOf(exe!);
        // A probe that failed to run must not read as a pass — the vacuity shape this
        // estate keeps finding.
        expect(got.ok, got.ok ? '' : `electron probe ${got.why}`).toBe(true);
        if (!got.ok) return;
        expect(
            nodeMajorOk(got.version),
            `Electron bundles Node ${got.version}, below the ACP floor of ${ACP_MIN_NODE_MAJOR}. ` +
                'ACP would refuse at spawn and the transport would be silently dead.',
        ).toBe(true);
    });

    it.skipIf(exe !== null)('is unverifiable here, and says so rather than passing quietly', () => {
        // Documents the skip instead of leaving a silent hole: on a machine without the
        // dist this check provides NO coverage, and that fact should be visible in the
        // output rather than inferred from a green tick.
        expect(exe).toBeNull();
    });
});
