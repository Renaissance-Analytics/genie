import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_SIGNATURE_FILE, packageDigest, packageLimitProblem, packagePathProblem, packageSigningBytes, type PackageFile } from '../core/plugin-integrity.js';
import { installDecision, verifyPluginSignature, type InstallDecision } from '../core/plugins.js';

/**
 * A PLUGIN PACKAGE ON DISK, READ FOR ITS SIGNATURE (ADF B4, Tynn #454). Every regular file of the folder, recursively,
 * as `genie-package/1` names them (core/plugin-integrity.ts). The folder is walked first, without reading a file: a
 * link or other non-regular entry, a bad path, or a package past the limits is refused before any byte is read or
 * hashed, the reason in words.
 */
export type PackageRead = { ok: true; files: PackageFile[] } | { ok: false; reason: string };

export async function readPackageFiles(dir: string, options: { onRead?: (path: string) => void } = {}): Promise<PackageRead> {
    const entries: Array<{ path: string; size: number }> = [];
    const walk = async (relative: string): Promise<string | null> => {
        const names = (await readdir(relative === '' ? dir : join(dir, relative))).sort();
        for (const name of names) {
            const path = relative === '' ? name : `${relative}/${name}`;
            const problem = packagePathProblem(path);
            if (problem) return problem;
            const stat = await lstat(join(dir, path));
            if (stat.isSymbolicLink()) return `${path} is a link; a package holds plain files only`;
            if (stat.isDirectory()) {
                const inner = await walk(path);
                if (inner) return inner;
                continue;
            }
            if (!stat.isFile()) return `${path} is not a regular file; a package holds plain files only`;
            entries.push({ path, size: stat.size });
            // Stop walking a package already past the file limit: the count alone refuses it.
            if (entries.length > 10_000) return packageLimitProblem(entries);
        }
        return null;
    };
    let problem: string | null;
    try {
        problem = await walk('');
    } catch (error) {
        return { ok: false, reason: `the package could not be read: ${(error as Error).message}` };
    }
    if (problem) return { ok: false, reason: problem };
    const limits = packageLimitProblem(entries);
    if (limits) return { ok: false, reason: limits };
    const files: PackageFile[] = [];
    for (const e of entries) {
        options.onRead?.(e.path);
        files.push({ path: e.path, bytes: await readFile(join(dir, e.path)) });
    }
    return { ok: true, files };
}

/**
 * A package's verdict: its files read, its digest taken, its signature checked against the publisher keys Genie holds,
 * and the install decision. `digest` is set only for a package signed as it is now, which is re-checked before each run.
 */
export async function checkPackage(dir: string, input: { keyId: string; keys: Readonly<Record<string, string>>; developerMode: boolean }): Promise<{ decision: InstallDecision; digest: string | null }> {
    const read = await readPackageFiles(dir);
    if (!read.ok) return { decision: { install: false, reason: `refused: ${read.reason}` }, digest: null };
    const digest = packageDigest(read.files);
    const sig = read.files.find((f) => f.path === PACKAGE_SIGNATURE_FILE);
    const check = verifyPluginSignature({ bytes: packageSigningBytes(digest), signature: sig ? sig.bytes.toString('utf8') : null, keyId: input.keyId }, input.keys);
    return { decision: installDecision(check, { developerMode: input.developerMode }), digest: check.signed ? digest : null };
}

/** The digest of a package as it is on disk now, or why it cannot be read. */
export async function currentDigest(dir: string): Promise<{ ok: true; digest: string } | { ok: false; reason: string }> {
    const read = await readPackageFiles(dir);
    return read.ok ? { ok: true, digest: packageDigest(read.files) } : read;
}
