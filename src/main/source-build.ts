import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ArchiveInstallOutcome, ArchiveInstallPorts } from './archive-install.js';

/**
 * THE SHARED SOURCE BUILDER for Genie-managed language versions that have no official relocatable build on this OS
 * (plan `.ai/plans/genie-2-toolchain-rest.md`: TC4b Python on Linux; TC5 PHP off Windows will use it too). The archive
 * installer's guarantees, for a build:
 *
 *   download → check the sha256 the official source publishes (NOTHING is written before that) → unpack into staging →
 *   run the build steps, which install straight into `<root>/<version>` (a built interpreter bakes its prefix in, so it
 *   is built where it will live) → finish → prove → or delete every byte of it, staging and the half-built directory.
 *
 * Every step is argv, never a shell, through the ports — so the tests drive it with fakes that count.
 */

export interface BuildStep {
    /** What the person reads while it runs: `configuring`, `compiling`. */
    readonly say: string;
    readonly bin: string;
    readonly args: readonly string[];
}

export interface SourceBuildSpec {
    /** What the person reads: `Python 3.15.1`. */
    readonly label: string;
    readonly version: string;
    readonly file: string;
    readonly url: string;
    readonly publisher: string;
    readonly expectedSha: () => Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
    /** The tarball's one top folder (`Python-3.15.1`). */
    readonly srcFolder: string;
    /** The build, given the unpacked source directory and the final directory. */
    readonly steps: (src: string, dir: string) => readonly BuildStep[];
    /** In the final directory, before the proof (`null` = done, else why not). */
    readonly finish?: (dir: string) => Promise<string | null>;
    /** `null` = proven, else why not. */
    readonly prove: (dir: string) => Promise<string | null>;
}

export async function buildFromSource(spec: SourceBuildSpec, ports: ArchiveInstallPorts): Promise<ArchiveInstallOutcome> {
    const { label, version, file } = spec;
    const say = (step: string) => ports.progress?.(step);
    const notInstalled = (reason: string): ArchiveInstallOutcome => ({ kind: 'not-installed', reason: `${reason}. Nothing was installed` });
    try {
        say(`${label}: downloading ${file} from ${spec.publisher}`);
        const got = await ports.fetchBytes(spec.url);
        if (!got.ok) return notInstalled(`${file} could not be downloaded from ${spec.url} (${got.error})`);
        say(`${label}: checking ${file} against the sha256 ${spec.publisher} publishes`);
        const expected = await spec.expectedSha();
        if (!expected.ok) return notInstalled(`${expected.reason}, so ${file} was not trusted`);
        const actual = createHash('sha256').update(got.body).digest('hex');
        if (actual !== expected.sha) return notInstalled(`${file} does not match the sha256 ${spec.publisher} publishes (expected ${expected.sha}, got ${actual}); it was discarded unopened`);
        return await build(spec, got.body, ports, say);
    } finally {
        ports.progress?.(null);
    }
}

async function build(spec: SourceBuildSpec, bytes: Uint8Array, ports: ArchiveInstallPorts, say: (step: string) => void): Promise<ArchiveInstallOutcome> {
    const { label, version, file } = spec;
    const staging = join(ports.root, `.staging-${version}`);
    const archivePath = join(ports.root, `.${file}`);
    const dir = join(ports.root, version);
    const clean = () => {
        for (const p of [staging, archivePath, dir]) {
            try { if (ports.fs.exists(p)) ports.fs.removeTree(p); } catch { /* the reason below is what matters */ }
        }
    };
    const fail = (reason: string): ArchiveInstallOutcome => { clean(); return { kind: 'not-installed', reason: `${reason}. Nothing was installed` }; };
    const runStep = async (step: BuildStep): Promise<string | null> => {
        say(`${label}: ${step.say}`);
        let r: { stdout: string; exitCode: number };
        try {
            r = await ports.run(step.bin, step.args);
        } catch (error) {
            return `${label} could not be built — ${step.say} did not run: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (r.exitCode === 0) return null;
        const words = r.stdout.trim().split(/\r?\n/).slice(-6).join(' | ').slice(-600);
        return `${label} could not be built — ${step.say} failed (exit ${r.exitCode})${words ? `: ${words}` : ''}`;
    };
    try {
        if (ports.fs.exists(staging)) ports.fs.removeTree(staging);
        if (ports.fs.exists(dir)) ports.fs.removeTree(dir);
        ports.fs.mkdirp(staging);
        ports.fs.writeBytes(archivePath, bytes);
        const unpacked = await runStep({ say: 'unpacking', bin: 'tar', args: ['-xzf', archivePath, '-C', staging] });
        if (unpacked !== null) return fail(unpacked);
        const src = join(staging, spec.srcFolder);
        if (!ports.fs.exists(src)) return fail(`${file} unpacked, but ${spec.srcFolder} is not in it — the archive did not lay out the way Genie expected`);
        ports.fs.removeTree(archivePath);
        for (const step of spec.steps(src, dir)) {
            const problem = await runStep(step);
            if (problem !== null) return fail(problem);
        }
        ports.fs.removeTree(staging);
        if (spec.finish) {
            say(`${label}: finishing the install`);
            const unfinished = await spec.finish(dir);
            if (unfinished !== null) return fail(unfinished);
        }
        say(`${label}: checking that it runs`);
        const problem = await spec.prove(dir);
        if (problem !== null) return fail(problem);
        return { kind: 'installed', version, dir };
    } catch (error) {
        return fail(`${label} could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
}
