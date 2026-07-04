import crypto, { X509Certificate } from 'node:crypto';

/**
 * Per-session Genie CA for the Testing Browser (serve-local-sites Phase D, design
 * §4 "valid lock via a session-only Genie CA").
 *
 * We MITM-terminate `https://<name>.gen` inside the Testing Browser's dedicated
 * Electron `session` so the remote sees a REAL secure context (green lock, secure
 * cookies, service workers, `crypto.subtle`) for the tunneled site — WITHOUT ever
 * touching the OS trust store or Herd's CA. To do that the forward-proxy shim
 * needs a leaf cert for each `*.gen` name, signed by a CA the session trusts.
 *
 * SECURITY (design §5 "remote-side CA is session-scoped"):
 *   - The CA keypair + self-signed CA cert are generated FRESH per Testing-Browser
 *     session (one per host connection — see design decision #2 / §7 analogue), so
 *     a leaked `.gen` cert is inert: it is trusted ONLY inside that one session via
 *     `session.setCertificateVerifyProc` (see main/testing-browser), NEVER the OS
 *     trust store, and `*.gen` resolves nowhere else (Genie's session proxy is the
 *     only resolver).
 *   - `verifyLeaf` is what the session's cert-verify proc calls: it accepts a
 *     presented leaf ONLY when it chains to THIS session's CA (checkIssued + a
 *     signature verify against the CA public key) and is currently valid. A cert
 *     from a DIFFERENT session's CA fails closed — that is the per-connection
 *     `.gen` isolation guarantee at the crypto layer.
 *
 * KEYGEN: keys come from Node's native `crypto.generateKeyPairSync` (fast, ~60ms),
 * and node-forge only assembles + signs the X.509 structure (Node has no cert
 * BUILDER, only the read-only `X509Certificate`). Verification uses Node's built-in
 * `X509Certificate` (no forge), so the trust decision never leaves the platform
 * crypto. One shared leaf keypair backs every issued leaf (standard MITM practice)
 * — only the per-name cert differs, and issued leaves are cached by name.
 */

// --- minimal node-forge typing --------------------------------------------
// node-forge ships no types and we deliberately DON'T add an ambient
// `declare module 'node-forge'` (it would collide with a future
// `@types/node-forge` the owner may install). Instead we type ONLY the surface we
// use and load it through a CommonJS require cast — see the dependency flag in the
// Phase D report.

interface ForgeCertificate {
    publicKey: unknown;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: Array<{ name: string; value: string }>): void;
    setIssuer(attrs: Array<{ name: string; value: string }>): void;
    setExtensions(exts: Array<Record<string, unknown>>): void;
    sign(key: unknown, md: unknown): void;
}
interface ForgePki {
    privateKeyFromPem(pem: string): unknown;
    publicKeyFromPem(pem: string): unknown;
    createCertificate(): ForgeCertificate;
    certificateToPem(cert: ForgeCertificate): string;
    privateKeyToPem(key: unknown): string;
}
interface Forge {
    pki: ForgePki;
    md: { sha256: { create(): unknown } };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const forge = require('node-forge') as Forge;

/** A signed leaf cert + its private key, both PEM — fed to `tls.createSecureContext`. */
export interface LeafCert {
    certPem: string;
    keyPem: string;
    /** The session CA cert PEM (so a caller can build the full chain if wanted). */
    caPem: string;
}

/** CA + leaf validity window. Session-scoped + regenerated per session, so this is
 *  only an upper bound on a single Testing-Browser session's lifetime. ~397 days
 *  keeps a long-lived session valid; the leaf is bypass-verified (our own
 *  verifyProc), so the public-CA 398-day leaf cap does not apply. */
const VALIDITY_MS = 397 * 24 * 60 * 60 * 1000;
/** A small backdate so a just-issued cert isn't "not yet valid" under clock skew. */
const BACKDATE_MS = 60 * 60 * 1000;

const CA_SUBJECT = [{ name: 'commonName', value: 'Genie Testing Browser Session CA' }];

function genKeyPair(): { priv: unknown; pub: unknown; privPem: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return {
        priv: forge.pki.privateKeyFromPem(privateKey),
        pub: forge.pki.publicKeyFromPem(publicKey),
        privPem: privateKey,
    };
}

/** A short random hex serial (positive, ≤20 bytes) for each cert. */
function randomSerial(): string {
    // Leading '00' keeps the DER INTEGER positive; the rest is random.
    return `00${crypto.randomBytes(15).toString('hex')}`;
}

/**
 * A per-Testing-Browser-session Certificate Authority. Construct ONE per host
 * connection; issue a leaf per `*.gen` name on demand; `verifyLeaf` is the trust
 * oracle the session's `setCertificateVerifyProc` consults.
 */
export class SessionCa {
    /** The self-signed CA cert, PEM — trusted ONLY inside this session. */
    readonly caPem: string;
    /** Node's parsed CA cert — the verification anchor (`checkIssued` + `verify`). */
    private readonly caX509: X509Certificate;
    private readonly caPrivateKey: unknown;
    /** One leaf keypair shared across all issued leaves (only the cert differs). */
    private readonly leafPub: unknown;
    private readonly leafKeyPem: string;
    /** Issued leaves cached by lowercased `.gen` name (repeat SNI is instant). */
    private readonly leaves = new Map<string, LeafCert>();

    constructor() {
        const ca = genKeyPair();
        this.caPrivateKey = ca.priv;
        const now = Date.now();
        const caCert = forge.pki.createCertificate();
        caCert.publicKey = ca.pub;
        caCert.serialNumber = randomSerial();
        caCert.validity.notBefore = new Date(now - BACKDATE_MS);
        caCert.validity.notAfter = new Date(now + VALIDITY_MS);
        caCert.setSubject(CA_SUBJECT);
        caCert.setIssuer(CA_SUBJECT);
        caCert.setExtensions([
            { name: 'basicConstraints', cA: true, critical: true },
            { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        ]);
        caCert.sign(this.caPrivateKey, forge.md.sha256.create());
        this.caPem = forge.pki.certificateToPem(caCert);
        this.caX509 = new X509Certificate(this.caPem);

        const leaf = genKeyPair();
        this.leafPub = leaf.pub;
        this.leafKeyPem = leaf.privPem;
    }

    /**
     * Issue (or return the cached) leaf cert for a `*.gen` name, signed by this
     * session CA with the name in CN + a dNSName SAN. Caller is responsible for
     * only ever asking for an ENABLED `.gen` name (the shim's allowlist gate).
     */
    issueLeaf(name: string): LeafCert {
        const key = name.toLowerCase();
        const cached = this.leaves.get(key);
        if (cached) return cached;
        const now = Date.now();
        const cert = forge.pki.createCertificate();
        cert.publicKey = this.leafPub;
        cert.serialNumber = randomSerial();
        cert.validity.notBefore = new Date(now - BACKDATE_MS);
        cert.validity.notAfter = new Date(now + VALIDITY_MS);
        cert.setSubject([{ name: 'commonName', value: key }]);
        cert.setIssuer(CA_SUBJECT);
        cert.setExtensions([
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            { name: 'subjectAltName', altNames: [{ type: 2, value: key }] },
        ]);
        cert.sign(this.caPrivateKey, forge.md.sha256.create());
        const issued: LeafCert = {
            certPem: forge.pki.certificateToPem(cert),
            keyPem: this.leafKeyPem,
            caPem: this.caPem,
        };
        this.leaves.set(key, issued);
        return issued;
    }

    /**
     * The trust oracle for `session.setCertificateVerifyProc`: TRUE only when the
     * presented leaf (PEM or DER) chains to THIS session's CA and is currently
     * valid. A cert from another session's CA — or an expired/garbage one — is
     * false (fail closed). This is what makes hostA's `tynn.gen` and hostB's
     * `tynn.gen` cryptographically distinct: each verifies only against its own CA.
     */
    verifyLeaf(pemOrDer: string | Buffer): boolean {
        let leaf: X509Certificate;
        try {
            leaf = new X509Certificate(pemOrDer);
        } catch {
            return false;
        }
        try {
            if (!leaf.checkIssued(this.caX509)) return false;
            if (!leaf.verify(this.caX509.publicKey)) return false;
        } catch {
            return false;
        }
        const now = Date.now();
        const from = Date.parse(leaf.validFrom);
        const to = Date.parse(leaf.validTo);
        if (Number.isNaN(from) || Number.isNaN(to)) return false;
        return now >= from && now <= to;
    }
}
