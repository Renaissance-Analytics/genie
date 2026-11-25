#!/usr/bin/env node
/**
 * SIGNS TRACK MANIFESTS (Tynn #1058 L1), in the PROTECTED release job only. Writes `<manifest>.sig` beside each
 * manifest: the Ed25519 signature over the manifest's exact bytes, in standard padded base64, one line, no newline
 * (contracts/track-manifest.schema.json). The launcher builds in the matching public key.
 *
 *   GENIE_MANIFEST_SIGNING_KEY=<PKCS#8 PEM> [GENIE_MANIFEST_PUBLIC_KEY=<base64 raw 32 bytes>] \
 *     node scripts/sign-manifest.mjs <manifest.json>...
 *   GENIE_MANIFEST_SIGNING_KEY=... node scripts/sign-manifest.mjs --public     prints the public key to build in
 *
 * The key comes from the environment only (a secret of the protected release environment), is never written or
 * printed, and is refused unless it is Ed25519. With GENIE_MANIFEST_PUBLIC_KEY set, a key that is not that one is refused,
 * so a job can never sign with a key the launcher does not trust. A manifest the launcher would refuse is not signed.
 * The key's custody and setup are the owner's (the PR that added this says how); no agent makes or holds one.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkManifest } from './pack-track.mjs';

function privateKey(pem) {
    let key;
    try { key = createPrivateKey({ key: pem, format: 'pem' }); } catch { throw new Error('the signing key is not a PKCS#8 PEM private key'); }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the signing key is ${key.asymmetricKeyType}, not Ed25519`);
    return key;
}

/** The raw 32-byte public key, base64: what the launcher builds in. */
export function publicKeyOf(pem) {
    return createPublicKey(privateKey(pem)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

/** The signature over `bytes`, as manifest.json.sig holds it. */
export function signManifestBytes(bytes, pem) {
    return sign(null, bytes, privateKey(pem)).toString('base64');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const pem = process.env.GENIE_MANIFEST_SIGNING_KEY;
    if (!pem) { console.error('sign-manifest: GENIE_MANIFEST_SIGNING_KEY is not set (the release environment\'s secret)'); process.exit(2); }
    const paths = process.argv.slice(2);
    try {
        const pub = publicKeyOf(pem);
        if (paths.length === 1 && paths[0] === '--public') { console.log(pub); process.exit(0); }
        if (paths.length === 0) { console.error('usage: sign-manifest.mjs <manifest.json>... | --public'); process.exit(2); }
        const expected = process.env.GENIE_MANIFEST_PUBLIC_KEY;
        if (expected && expected.trim() !== pub) throw new Error(`the signing key is not the key the launcher trusts (its public key is ${pub})`);
        const signed = [];
        for (const path of paths) {
            const bytes = await readFile(path);
            if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`${path} starts with a byte-order mark`);
            let value;
            try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${path} is not JSON`); }
            checkManifest(value);
            signed.push([path, signManifestBytes(bytes, pem)]);
        }
        for (const [path, sig] of signed) { await writeFile(`${path}.sig`, sig); console.log(`signed ${path}`); }
    } catch (e) {
        console.error(`sign-manifest: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
    }
}
