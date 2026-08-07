import crypto from 'node:crypto';

/**
 * Shared X.509 assembly primitives.
 *
 * Two Genie subsystems mint short-lived certificates: the per-session Testing
 * Browser CA (main/remote/site-ca.ts) and the stable host-native `.gen` CA
 * (main/dev-server/host-ca.ts). Both need the SAME delicate DER-correctness
 * details — most of all the genie#78 serial-encoding fix and the "assemble with
 * forge, sign the TBS with Node/OpenSSL" workaround — so they live here ONCE
 * rather than being copy-pasted (a copy would let the two drift, and the serial
 * fix is exactly the kind of subtlety that regresses when duplicated).
 *
 * KEYGEN uses Node's native `crypto.generateKeyPairSync`; node-forge only
 * assembles + serialises the X.509 structure (Node has no cert BUILDER, only the
 * read-only `X509Certificate`). Verification stays on Node's `X509Certificate`
 * (in the callers), so the trust decision never leaves the platform crypto.
 */

// --- minimal node-forge typing --------------------------------------------
// node-forge's own types are loaded via @types/node-forge, but we keep a narrow
// local surface + a CommonJS require cast, matching the original site-ca.ts, so
// this module compiles the same way regardless of that package's shape.
interface ForgeCertificate {
    publicKey: unknown;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: Array<{ name: string; value: string }>): void;
    setIssuer(attrs: Array<{ name: string; value: string }>): void;
    setExtensions(exts: Array<Record<string, unknown>>): void;
    sign(key: unknown, md: unknown): void;
    signatureOid?: string;
    siginfo?: { algorithmOid?: string };
    tbsCertificate?: unknown;
    signature?: string;
}
interface ForgePki {
    publicKeyFromPem(pem: string): unknown;
    createCertificate(): ForgeCertificate;
    getTBSCertificate(cert: ForgeCertificate): unknown;
    certificateToPem(cert: ForgeCertificate): string;
    privateKeyToPem(key: unknown): string;
}
interface Forge {
    pki: ForgePki;
    md: { sha256: { create(): unknown } };
    asn1: { toDer(value: unknown): { getBytes(): string } };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const forge = require('node-forge') as Forge;

const SHA256_WITH_RSA_OID = '1.2.840.113549.1.1.11';

/** A generated RSA keypair: the forge public key (for cert assembly) + the
 *  PKCS#1 private key PEM (for signing + `tls.createSecureContext`). */
export interface KeyPair {
    pub: unknown;
    privPem: string;
}

/** Generate an RSA keypair via Node's native (fast, ~60ms) generator. */
export function genKeyPair(): KeyPair {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return { pub: forge.pki.publicKeyFromPem(publicKey), privPem: privateKey };
}

/**
 * A random hex serial (positive, ≤20 bytes) for each cert — the genie#78 fix.
 *
 * A DER INTEGER must be POSITIVE and MINIMALLY encoded; a leading `0x00` is legal
 * only when it stops the next byte reading as a sign bit. node-forge's DER writer
 * strips exactly ONE redundant pad byte, so a draw beginning `00 <msb-clear>`
 * still emitted a non-minimal integer that OpenSSL rejected with
 * `error:068000DD:asn1 encoding routines::illegal padding` (~1 cert in 500).
 * We make the leading byte minimal BY CONSTRUCTION: clear its sign bit so no pad
 * byte is needed, and keep it non-zero so it can't itself be a pad byte.
 */
export function randomSerial(): string {
    const bytes = crypto.randomBytes(16);
    bytes[0] = (bytes[0] & 0x7f) || 0x01;
    return bytes.toString('hex');
}

/** Assemble the certificate with forge, but sign the TBS bytes with Node/OpenSSL.
 *  Forge's pure-JS RSA signer intermittently emitted a malformed signature BIT
 *  STRING under full-suite CPU contention; native signing keeps construction
 *  synchronous while removing that nondeterministic seam. */
function signCertificate(cert: ForgeCertificate, privateKeyPem: string): void {
    cert.signatureOid = SHA256_WITH_RSA_OID;
    cert.siginfo = { algorithmOid: SHA256_WITH_RSA_OID };
    cert.tbsCertificate = forge.pki.getTBSCertificate(cert);
    const tbs = forge.asn1.toDer(cert.tbsCertificate).getBytes();
    cert.signature = crypto.sign('sha256', Buffer.from(tbs, 'binary'), privateKeyPem).toString('binary');
}

/** Everything needed to build one signed certificate. */
export interface CertSpec {
    /** The forge public key the cert binds (from {@link genKeyPair}). */
    publicKey: unknown;
    notBefore: Date;
    notAfter: Date;
    subject: Array<{ name: string; value: string }>;
    issuer: Array<{ name: string; value: string }>;
    extensions: Array<Record<string, unknown>>;
    /** PEM of the ISSUER's private key (self for a CA, the CA's for a leaf). */
    signingKeyPem: string;
    /** Override the serial (else a fresh {@link randomSerial}). */
    serialHex?: string;
}

/** Build + sign a certificate, returning its PEM. The single seam both CAs use so
 *  the serial fix + native-signing workaround apply everywhere identically. */
export function buildSignedCertPem(spec: CertSpec): string {
    const cert = forge.pki.createCertificate();
    cert.publicKey = spec.publicKey;
    cert.serialNumber = spec.serialHex ?? randomSerial();
    cert.validity.notBefore = spec.notBefore;
    cert.validity.notAfter = spec.notAfter;
    cert.setSubject(spec.subject);
    cert.setIssuer(spec.issuer);
    cert.setExtensions(spec.extensions);
    signCertificate(cert, spec.signingKeyPem);
    return forge.pki.certificateToPem(cert);
}
