import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * THE SHARED ARCHIVE INSTALLER for Genie-managed language versions (plan `.ai/plans/genie-2-toolchain-rest.md`, TC2):
 * the steps the PHP and Node managers each wrote out, once —
 *
 *   download → check the sha256 the official source publishes (NOTHING is written before that) → unpack into a
 *   staging directory → move the archive's one top folder into `<root>/<version>` → prove it runs → or delete every
 *   byte of it.
 *
 * A failure after the unpack leaves nothing behind, because a half-installed directory with a binary in it would be
 * listed as an install. Every effect goes through the ports, so the tests drive it with fakes that count.
 */

export type ArchivePlatform = 'win32' | 'linux' | 'darwin';

export interface ArchiveInstallPorts {
    readonly platform: ArchivePlatform;
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly progress?: (step: string | null) => void;
}

export interface ArchiveSpec {
    /** What the person reads: `Go 1.27.3`. */
    readonly label: string;
    readonly version: string;
    /** The archive's file name and where it comes from. */
    readonly file: string;
    readonly url: string;
    /** Who publishes the checksum, for the refusal's words: `go.dev`. */
    readonly publisher: string;
    /** The published sha256 for `file`, read from the publisher — or why it could not be. */
    readonly expectedSha: () => Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
    /** The archive's single top folder (`go`, `node-v24.22.1-win-x64`) — or `null` for a FLAT archive whose files are
     *  the install itself (python.org's Windows zips: python.exe at the top). */
    readonly topFolder: string | null;
    /**
     * Anything that must happen IN the final directory before the proof (`null` = done, else why not): Python's
     * `Scripts\pip.exe` bakes in the python that made it, so it is made here, never in staging.
     */
    readonly finish?: (dir: string) => Promise<string | null>;
    /** Proves the moved directory runs: `null` = proven, else why not. */
    readonly prove: (dir: string) => Promise<string | null>;
}

export type ArchiveInstallOutcome =
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

/** A PowerShell single-quoted literal: `'` doubled. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Download, verify, unpack, move, prove — or leave nothing. The caller has already checked consent and the recipe. */
export async function installArchive(spec: ArchiveSpec, ports: ArchiveInstallPorts): Promise<ArchiveInstallOutcome> {
    const { label, version, file } = spec;
    const say = (step: string) => ports.progress?.(step);
    const notInstalled = (reason: string): ArchiveInstallOutcome => ({ kind: 'not-installed', reason: `${reason}. Nothing was installed` });
    try {
        say(`${label}: downloading ${file} from ${spec.publisher}`);
        const got = await ports.fetchBytes(spec.url);
        if (!got.ok) return notInstalled(`${file} could not be downloaded from ${spec.url} (${got.error})`);

        // THE CHECKSUM, before a byte is written.
        say(`${label}: checking ${file} against the sha256 ${spec.publisher} publishes`);
        const expected = await spec.expectedSha();
        if (!expected.ok) return notInstalled(`${expected.reason}, so ${file} was not trusted`);
        const actual = createHash('sha256').update(got.body).digest('hex');
        if (actual !== expected.sha) return notInstalled(`${file} does not match the sha256 ${spec.publisher} publishes (expected ${expected.sha}, got ${actual}); it was discarded unopened`);

        return await putInPlace(spec, got.body, ports, say);
    } finally {
        ports.progress?.(null);
    }
}

async function putInPlace(spec: ArchiveSpec, bytes: Uint8Array, ports: ArchiveInstallPorts, say: (step: string) => void): Promise<ArchiveInstallOutcome> {
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
    try {
        if (ports.fs.exists(staging)) ports.fs.removeTree(staging);
        ports.fs.mkdirp(staging);
        ports.fs.writeBytes(archivePath, bytes);
        say(`${label}: unpacking`);
        // argv, never a shell. Windows: PowerShell's Expand-Archive for a .zip (what the PHP and Node managers use);
        // macOS and Linux: tar for a .tar.gz.
        const [bin, args] = ports.platform === 'win32'
            ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(staging)} -Force`]] as const
            : ['tar', ['-xzf', archivePath, '-C', staging]] as const;
        let unpacked: { stdout: string; exitCode: number };
        try {
            unpacked = await ports.run(bin, args);
        } catch (error) {
            return fail(`${file} could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (unpacked.exitCode !== 0) return fail(`${file} could not be unpacked (exit ${unpacked.exitCode})${unpacked.stdout.trim() ? `: ${unpacked.stdout.trim().slice(0, 300)}` : ''}`);
        ports.fs.removeTree(archivePath);
        if (spec.topFolder === null) {
            // A flat archive: the staging directory IS the install. What it must contain is the proof's to judge.
            ports.fs.rename(staging, dir);
        } else {
            const top = join(staging, spec.topFolder);
            if (!ports.fs.exists(top)) return fail(`${file} unpacked, but ${spec.topFolder} is not in it — the archive did not lay out the way Genie expected`);
            ports.fs.rename(top, dir);
            ports.fs.removeTree(staging);
        }

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
        return fail(`${label} could not be put in place: ${error instanceof Error ? error.message : String(error)}`);
    }
}
