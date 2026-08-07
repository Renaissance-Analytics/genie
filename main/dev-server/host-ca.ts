import { X509Certificate } from 'node:crypto';
import { buildSignedCertPem, genKeyPair } from '../host-core/crypto/x509';
import { assertGenName } from './hosts-file';

/**
 * The stable host-native `.gen` Certificate Authority (Wish #102, story #238,
 * task #674).
 *
 * Where the Testing-Browser CA (remote/site-ca.ts) is per-session and trusted only
 * inside one Electron session, THIS CA is PERSISTED and installed into the OS
 * trust store (owner-approved, one-time elevation) so the machine's REAL browser
 * shows a green lock for `https://<name>.gen` served by the host Caddy. Because
 * every live site is served by one host Caddy on :443, the CA issues a single
 * MULTI-SAN leaf covering every current `.gen` name (re-issued when the set
 * changes), not one leaf per name.
 *
 * The X.509 assembly (keygen, genie#78 serial fix, native TBS signing) is the
 * shared host-core/crypto/x509.ts. This file owns only the host-CA POLICY: a long
 * CA lifetime (it's trusted, so it must not silently expire), the CA/leaf
 * extensions, persistence, and the per-OS trust-store install command. The pure
 * crypto + injected-IO persistence are unit-tested; the elevated install spawn is
 * validated on a real machine.
 */

/** ~10 years — a trusted, persisted root shouldn't force the user to re-trust often. */
const CA_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** ~397 days — under the 825-day cap browsers enforce on server leaves even from a
 *  custom root; re-issued whenever the site set (or Caddy) restarts anyway. */
const LEAF_VALIDITY_MS = 397 * 24 * 60 * 60 * 1000;
const BACKDATE_MS = 60 * 60 * 1000;
/** Rotate a stored CA once it's within this of expiry, so a trusted anchor never
 *  lapses mid-use (which would break every `.gen` until re-trusted). */
const CA_RENEW_MARGIN_MS = 30 * 24 * 60 * 60 * 1000;

const CA_SUBJECT = [
    { name: 'commonName', value: 'Genie Local Development CA' },
    { name: 'organizationName', value: 'Genie' },
];

/** The persisted CA cert + private key (both PEM). The cert is installed in the
 *  trust store; the key stays host-only and signs the leaf. */
export interface GenCaMaterial {
    caPem: string;
    caKeyPem: string;
}

/** The multi-SAN leaf the host Caddy serves for every `.gen`. */
export interface GenLeaf {
    certPem: string;
    keyPem: string;
}

/** Validate, lowercase-dedupe and sort the leaf's names; a leaf needs ≥1. */
function normaliseGenNames(genNames: string[]): string[] {
    for (const n of genNames) assertGenName(n);
    const set = new Set(genNames);
    const names = [...set].sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
        throw new Error('host-ca: refusing to issue a leaf with no .gen names');
    }
    return names;
}

/** Generate a fresh, self-signed Genie root CA. Persist it (see
 *  {@link loadOrCreateGenCa}) so the same anchor stays trusted across restarts. */
export function generateGenCa(): GenCaMaterial {
    const ca = genKeyPair();
    const now = Date.now();
    const caPem = buildSignedCertPem({
        publicKey: ca.pub,
        notBefore: new Date(now - BACKDATE_MS),
        notAfter: new Date(now + CA_VALIDITY_MS),
        subject: CA_SUBJECT,
        issuer: CA_SUBJECT,
        extensions: [
            { name: 'basicConstraints', cA: true, critical: true },
            { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        ],
        signingKeyPem: ca.privPem,
    });
    return { caPem, caKeyPem: ca.privPem };
}

/** Issue the host Caddy's leaf: one cert whose SANs are every live `.gen`, CN the
 *  first, signed by `ca`. A fresh leaf keypair each call — the cert is the artifact
 *  the caller persists + points Caddy's `tls` at. */
export function issueGenLeaf(ca: GenCaMaterial, genNames: string[]): GenLeaf {
    const names = normaliseGenNames(genNames);
    const leaf = genKeyPair();
    const now = Date.now();
    const certPem = buildSignedCertPem({
        publicKey: leaf.pub,
        notBefore: new Date(now - BACKDATE_MS),
        notAfter: new Date(now + LEAF_VALIDITY_MS),
        subject: [{ name: 'commonName', value: names[0] }],
        issuer: CA_SUBJECT,
        extensions: [
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            // type 2 = dNSName.
            { name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) },
        ],
        signingKeyPem: ca.caKeyPem,
    });
    return { certPem, keyPem: leaf.privPem };
}

/** True when a stored CA cert is a usable, non-imminently-expiring CA. */
function isCaUsable(caPem: string): boolean {
    try {
        const x = new X509Certificate(caPem);
        if (x.ca !== true) return false;
        const notAfter = Date.parse(x.validTo);
        return !Number.isNaN(notAfter) && notAfter - Date.now() > CA_RENEW_MARGIN_MS;
    } catch {
        return false;
    }
}

/** Read the persisted CA cert + key (either may be absent), and write a freshly
 *  generated pair. Injected so tests supply fakes and the real caller supplies the
 *  on-disk store (host-only, 0600 key). */
export interface GenCaStore {
    readCert: () => Promise<string | null>;
    readKey: () => Promise<string | null>;
    write: (material: GenCaMaterial) => Promise<void>;
}

/** Return the persisted CA, or generate + persist one when absent/invalid/expiring.
 *  `created` tells the caller a NEW anchor was minted, i.e. the trust-store install
 *  must run again. */
export async function loadOrCreateGenCa(
    store: GenCaStore,
): Promise<{ material: GenCaMaterial; created: boolean }> {
    const caPem = await store.readCert();
    const caKeyPem = await store.readKey();
    if (caPem && caKeyPem && isCaUsable(caPem)) {
        return { material: { caPem, caKeyPem }, created: false };
    }
    const material = generateGenCa();
    await store.write(material);
    return { material, created: true };
}

/** The command + args (NO shell — spawned with an argv array) that installs the CA
 *  cert at `caCertPath` into the OS trust store, per platform, and whether it needs
 *  elevation. The real caller runs this through the elevation helper and surfaces a
 *  loud error if the user declines. */
export function trustStoreInstallCommand(
    caCertPath: string,
    platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[]; needsElevation: boolean } {
    switch (platform) {
        case 'win32':
            // Adds to the Local Machine "Root" (Trusted Root CAs) store; -f overwrites.
            return { cmd: 'certutil', args: ['-addstore', '-f', 'Root', caCertPath], needsElevation: true };
        case 'darwin':
            return {
                cmd: 'security',
                args: [
                    'add-trusted-cert',
                    '-d',
                    '-r',
                    'trustRoot',
                    '-k',
                    '/Library/Keychains/System.keychain',
                    caCertPath,
                ],
                needsElevation: true,
            };
        default:
            // p11-kit's `trust anchor <file>` adds a system trust anchor in one step
            // across modern Linux (Fedora/Arch/Debian).
            return { cmd: 'trust', args: ['anchor', caCertPath], needsElevation: true };
    }
}
