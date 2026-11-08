import { sign, type KeyObject } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_SIGNATURE_FILE, packageDigest, packageSigningBytes } from '../src/core/plugin-integrity.js';
import { readPackageFiles } from '../src/main/plugin-package.js';

/**
 * Sign a plugin package folder the way a publisher does (ADF B4): a digest over every file in it, then an Ed25519
 * signature over that digest's signing bytes, written beside the manifest as genie-plugin.sig. Tests only.
 */
export async function signPackage(dir: string, privateKey: KeyObject): Promise<string> {
    const read = await readPackageFiles(dir);
    if (!read.ok) throw new Error(read.reason);
    const digest = packageDigest(read.files);
    await writeFile(join(dir, PACKAGE_SIGNATURE_FILE), sign(null, packageSigningBytes(digest), privateKey).toString('base64'));
    return digest;
}
