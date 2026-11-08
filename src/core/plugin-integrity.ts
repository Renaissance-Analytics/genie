import { createHash, createPublicKey } from 'node:crypto';

/**
 * CODE INTEGRITY: THE PACKAGE SIGNING FORMAT `genie-package/1` (ADF B4, Tynn #454) — pure. The owner's ruling: signed
 * packages only. A signature covers EVERY file of a package, not the manifest alone, so one byte changed in a tool's
 * code after signing is refused as tampered. The Tynn marketplace checks the same format on upload (C2); docs/sdk/
 * packages.md is generated from the words below (`PACKAGE_FORMAT_DOC`), so the published contract is this code's.
 */

/** The format's name, in the signed bytes. */
export const PACKAGE_FORMAT = 'genie-package/1';
/** The detached signature, at the package root: the one file the digest leaves out. */
export const PACKAGE_SIGNATURE_FILE = 'genie-plugin.sig';

/** Approved with the format (2026-11-08): checked on the files' sizes and paths, before any byte is read or hashed. */
export const PACKAGE_LIMITS = { files: 10_000, totalBytes: 200 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, pathBytes: 1024 } as const;

export interface PackageFile {
    /** Relative to the package root, `/` between segments. */
    readonly path: string;
    readonly bytes: Buffer;
}

const n = (x: number) => x.toLocaleString('en-US');
const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
const utf8 = (path: string) => Buffer.from(path, 'utf8');

/** Why a path cannot be in a package, in words; null when it can. */
export function packagePathProblem(path: string): string | null {
    if (/[\u0000-\u001f\u007f]/.test(path)) return `${JSON.stringify(path)} has a control character in its name`;
    if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return `${JSON.stringify(path)} is not a plain path inside the package`;
    return null;
}

/**
 * The limits, on what a package holds before anything is read: its files' paths and sizes. Null when within them; the
 * first one broken, in words, otherwise.
 */
export function packageLimitProblem(entries: ReadonlyArray<{ readonly path: string; readonly size: number }>): string | null {
    if (entries.length > PACKAGE_LIMITS.files) return `the package holds ${n(entries.length)} files; a package may hold at most ${n(PACKAGE_LIMITS.files)}`;
    let total = 0;
    for (const e of entries) {
        const pathBytes = utf8(e.path).length;
        if (pathBytes > PACKAGE_LIMITS.pathBytes) return `the package has a path of ${n(pathBytes)} bytes (${e.path.slice(0, 60)}…); a path may be at most ${n(PACKAGE_LIMITS.pathBytes)} bytes`;
        if (e.size > PACKAGE_LIMITS.fileBytes) return `${e.path} is ${n(e.size)} bytes; a package may hold at most ${mb(PACKAGE_LIMITS.fileBytes)} a file (${n(PACKAGE_LIMITS.fileBytes)} bytes)`;
        total += e.size;
    }
    if (total > PACKAGE_LIMITS.totalBytes) return `the package is ${n(total)} bytes; a package may be at most ${mb(PACKAGE_LIMITS.totalBytes)} in all (${n(PACKAGE_LIMITS.totalBytes)} bytes)`;
    return null;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The listing the digest is taken over: `<sha256 hex>  <path>\n` per file but the signature, by the UTF-8 bytes of the path. */
export function packageListing(files: readonly PackageFile[]): string {
    return files
        .filter((f) => f.path !== PACKAGE_SIGNATURE_FILE)
        .map((f) => ({ f, key: utf8(f.path) }))
        .sort((a, b) => Buffer.compare(a.key, b.key))
        .map(({ f }) => `${sha256(f.bytes)}  ${f.path}\n`)
        .join('');
}

/** The package digest: lowercase hex SHA-256 of the listing's UTF-8 bytes. */
export function packageDigest(files: readonly PackageFile[]): string {
    return sha256(Buffer.from(packageListing(files), 'utf8'));
}

/** What the publisher signs (Ed25519): `genie-package/1 sha256:<digest>\n`, ASCII. */
export function packageSigningBytes(digest: string): Buffer {
    return Buffer.from(`${PACKAGE_FORMAT} sha256:${digest}\n`, 'latin1');
}

/** A publisher key's id, as the Tynn marketplace's registry (C1) gives it: `sha256:` + hex SHA-256 of its SPKI DER. */
export function publisherKeyId(publicKeyPem: string): string {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return `sha256:${sha256(der)}`;
}

/** The format, for people: docs/sdk/packages.md is generated from this (src/core/sdk-docs.ts). */
export const PACKAGE_FORMAT_DOC: readonly string[] = [
    `A package's signature covers every file in it. The format is \`${PACKAGE_FORMAT}\`. Genie checks it when it loads its plugins and again before each run of a signed package's tool, and the Tynn marketplace checks it when a package is uploaded.`,
    '',
    '## 1. Which files',
    '',
    `Every regular file under the package folder, recursively, dotfiles included. Only \`${PACKAGE_SIGNATURE_FILE}\` at the package root is left out. Directories are not listed, so an empty directory changes nothing. A package holding a link or any other entry that is not a regular file is refused.`,
    '',
    '## 2. Paths',
    '',
    'Relative to the package root, `/` between segments, UTF-8, exactly as stored. A segment that is empty, `.` or `..`, or a control character (U+0000 to U+001F, U+007F) in a path, refuses the package.',
    '',
    '## 3. Limits',
    '',
    'Checked on the files\' paths and sizes before any byte is read or hashed; a package past one is refused, the reason saying which:',
    '',
    `- at most ${n(PACKAGE_LIMITS.files)} files;`,
    `- at most ${mb(PACKAGE_LIMITS.totalBytes)} in all (1 MB = 1,048,576 bytes);`,
    `- at most ${mb(PACKAGE_LIMITS.fileBytes)} a file;`,
    `- a path of at most ${n(PACKAGE_LIMITS.pathBytes)} bytes (UTF-8).`,
    '',
    '## 4. The listing and the digest',
    '',
    'Files are ordered by the UTF-8 bytes of their paths, compared byte by byte. Each gives one line, `sha256sum`\'s own format, the last one ending in a newline too:',
    '',
    '```',
    '<lowercase hex SHA-256 of the file\'s bytes><two spaces><path>\\n',
    '```',
    '',
    'The **digest** is the lowercase hex SHA-256 of the listing\'s UTF-8 bytes: 64 characters.',
    '',
    '## 5. The signature',
    '',
    'Ed25519 (RFC 8032, pure) over these ASCII bytes: the format\'s name, a space, `sha256:`, the digest, a newline.',
    '',
    '```',
    `${PACKAGE_FORMAT} sha256:<digest>\\n`,
    '```',
    '',
    `\`${PACKAGE_SIGNATURE_FILE}\`, at the package root, holds the 64-byte signature in standard base64 with padding. Whitespace around it is ignored.`,
    '',
    '## 6. The key',
    '',
    'An Ed25519 public key in SPKI. Its id is `sha256:` followed by the lowercase hex SHA-256 of the key\'s whole SPKI DER bytes: 71 characters, the `key_id` of the Tynn marketplace\'s publisher registry. Genie holds each key under that id, and does not trust a key held under an id that is not its fingerprint.',
    '',
    '## 7. The manifest',
    '',
    '`genie-plugin.json`, at the package root, is one of the signed files. Its `id` and `version` name the package; `publisher.name` names the publisher; `publisher.keyId` holds the signing key\'s id (the registry\'s `key_id`).',
    '',
    '## What Genie does',
    '',
    '- **Signed by a key Genie holds, and the package as signed:** it loads, labelled with its signer.',
    '- **A file changed, added or removed after signing, or a signature that does not verify:** refused as **tampered**, with publisher checks on or off.',
    '- **Unsigned, or signed by a key Genie does not hold:** refused, unless publisher checks are off; then it runs, labelled unsigned. A package running that way is the person\'s own work in progress and is not checked again before each run.',
];
