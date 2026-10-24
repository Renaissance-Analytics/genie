import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import {
    BACKDATE_MS,
    CA_VALIDITY_MS,
    GEN_CA_SUBJECT,
    LEAF_VALIDITY_MS,
    chooseCa,
    leafHosts,
    leafNeed,
    normaliseThumbprint,
    trustAnswer,
    trustQuery,
    type CaFacts,
    type LeafFacts,
    type LeafReason,
} from '../core/gen-ca.js';
import { issueCa, issueLeaf, type IssuedPem } from './x509.js';

/**
 * GENIE'S `.gen` CERTIFICATE AUTHORITY ON DISK — `~/.genie/runtime/gen-ca/`: `ca.crt`, `ca.key` (0600), `leaf.crt`,
 * `leaf.key` (0600), `adopted.json` when the CA came from Genie 1, `trust-prompt.json` when the person said Not now.
 * The choices are core/gen-ca.ts's; this file reads the facts they need, copies, issues and writes.
 *
 * Genie 1's files are READ, never written: adoption copies the certificate and key byte for byte, so Genie 1 (still
 * installed, or rolled back to) keeps its own CA exactly as it was.
 */

export type CaSource = 'own' | 'adopted-v1' | 'created';

/** Issues the two certificates; the X.509 builder by default. Injected so tests can count what is issued. */
export interface CertIssuer {
    ca(now: number): IssuedPem;
    leaf(ca: IssuedPem, hosts: readonly string[], now: number): IssuedPem;
}

export const x509Issuer: CertIssuer = {
    ca: (now) => issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(now - BACKDATE_MS), notAfter: new Date(now + CA_VALIDITY_MS) }),
    leaf: (ca, hosts, now) => issueLeaf(ca, hosts, new Date(now - BACKDATE_MS), new Date(now + LEAF_VALIDITY_MS)),
};

/** Genie 1's file names inside its `host-gen` folder (repos/genie main/dev-server). */
export const V1_CA_FILES = { cert: 'gen-ca.crt', key: 'gen-ca.key' } as const;

const readText = (path: string): string | null => {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
};

/** Write, then restrict: `mode` only applies when the file is created, so an existing file is chmod-ed too. */
function writePrivate(path: string, data: string | Buffer): void {
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
}

const spki = (key: KeyObject): Buffer => createPublicKey(key).export({ type: 'spki', format: 'der' });

export function thumbprintOf(cert: X509Certificate): string {
    return normaliseThumbprint(cert.fingerprint);
}

function caFacts(certPem: string | null, keyPem: string | null): CaFacts | null {
    if (certPem === null) return null;
    try {
        const cert = new X509Certificate(certPem);
        let keyMatches = false;
        if (keyPem !== null) {
            try {
                keyMatches = spki(createPrivateKey(keyPem)).equals(cert.publicKey.export({ type: 'spki', format: 'der' }));
            } catch {
                keyMatches = false;
            }
        }
        return { isCa: cert.ca, notAfter: Date.parse(cert.validTo), keyMatches };
    } catch {
        return { isCa: false, notAfter: 0, keyMatches: false };
    }
}

function dnsNames(cert: X509Certificate): string[] {
    return (cert.subjectAltName ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('DNS:'))
        .map((s) => s.slice(4).toLowerCase())
        .sort();
}

export interface GenCaOptions {
    /** `~/.genie/runtime/gen-ca`. */
    readonly dir: string;
    /** Genie 1's `host-gen` folders, in order; the first holding a usable CA is adopted when Genie 2 has none. */
    readonly v1Dirs: readonly string[];
    readonly now: () => number;
    readonly issuer?: CertIssuer;
    readonly log?: (line: string) => void;
}

export interface LeafFiles {
    readonly certPath: string;
    readonly keyPath: string;
    /** Why it was issued on this call; `null` = the one on disk still serves. */
    readonly issued: LeafReason | null;
}

export class GenCa {
    readonly source: CaSource;
    readonly thumbprint: string;
    readonly certPath: string;
    readonly keyPath: string;
    readonly #options: GenCaOptions;
    readonly #issuer: CertIssuer;
    readonly #material: IssuedPem;
    readonly #cert: X509Certificate;
    readonly #leafCert: string;
    readonly #leafKey: string;
    #leaf: LeafFacts | null | undefined = undefined;

    private constructor(options: GenCaOptions, source: CaSource, material: IssuedPem) {
        this.#options = options;
        this.#issuer = options.issuer ?? x509Issuer;
        this.source = source;
        this.#material = material;
        this.#cert = new X509Certificate(material.certPem);
        this.thumbprint = thumbprintOf(this.#cert);
        this.certPath = join(options.dir, 'ca.crt');
        this.keyPath = join(options.dir, 'ca.key');
        this.#leafCert = join(options.dir, 'leaf.crt');
        this.#leafKey = join(options.dir, 'leaf.key');
    }

    /** Own > Genie 1's (adopted by copying, recorded) > new. Synchronous: the front door's Caddyfile is written right after. */
    static open(options: GenCaOptions): GenCa {
        const now = options.now();
        const log = options.log ?? (() => {});
        const certPath = join(options.dir, 'ca.crt');
        const keyPath = join(options.dir, 'ca.key');
        const own = caFacts(readText(certPath), readText(keyPath));
        const v1 = options.v1Dirs.map((d) => caFacts(readText(join(d, V1_CA_FILES.cert)), readText(join(d, V1_CA_FILES.key))));
        const choice = chooseCa({ own, v1, now });
        mkdirSync(options.dir, { recursive: true });
        if (choice.use === 'own') return new GenCa(options, 'own', { certPem: readText(certPath)!, keyPem: readText(keyPath)! });
        if (choice.use === 'v1') {
            const from = options.v1Dirs[choice.index]!;
            // Bytes, not text: the copy is Genie 1's file exactly, whatever its line endings.
            const cert = readFileSync(join(from, V1_CA_FILES.cert));
            const key = readFileSync(join(from, V1_CA_FILES.key));
            writeFileSync(certPath, cert);
            writePrivate(keyPath, key);
            const ca = new GenCa(options, 'adopted-v1', { certPem: cert.toString('utf8'), keyPem: key.toString('utf8') });
            writeFileSync(join(options.dir, 'adopted.json'), `${JSON.stringify({ from, thumbprint: ca.thumbprint, at: new Date(now).toISOString() }, null, 2)}\n`, 'utf8');
            log(`[gen-ca] adopted Genie 1's CA from ${from} (${ca.thumbprint})`);
            return ca;
        }
        const material = (options.issuer ?? x509Issuer).ca(now);
        writeFileSync(certPath, material.certPem, 'utf8');
        writePrivate(keyPath, material.keyPem);
        const ca = new GenCa(options, 'created', material);
        log(`[gen-ca] created a new CA (${ca.thumbprint}): ${choice.why}`);
        return ca;
    }

    /** The leaf for these front-door hosts: the one on disk while it serves, else a new one (the reason returned). */
    leafFor(hosts: readonly string[]): LeafFiles {
        const want = leafHosts(hosts);
        if (want.length === 0) throw new Error('no .gen hosts to issue a certificate for');
        const now = this.#options.now();
        const need = leafNeed({ leaf: this.#leafFacts(), hosts: want, now });
        if (need !== null) {
            const issued = this.#issuer.leaf(this.#material, want, now);
            writeFileSync(this.#leafCert, issued.certPem, 'utf8');
            writePrivate(this.#leafKey, issued.keyPem);
            this.#leaf = { hosts: want, notAfter: Date.parse(new X509Certificate(issued.certPem).validTo), fromCa: true };
        }
        return { certPath: this.#leafCert, keyPath: this.#leafKey, issued: need };
    }

    /** Whether THIS person already said Not now to THIS CA (a renewed CA asks again). */
    trustDeferred(): string | null {
        const raw = readText(join(this.#options.dir, 'trust-prompt.json'));
        if (raw === null) return null;
        try {
            const data = JSON.parse(raw) as { notNowFor?: unknown };
            return typeof data.notNowFor === 'string' ? data.notNowFor : null;
        } catch {
            return null;
        }
    }

    deferTrust(): void {
        writeFileSync(join(this.#options.dir, 'trust-prompt.json'), `${JSON.stringify({ notNowFor: this.thumbprint, at: new Date(this.#options.now()).toISOString() }, null, 2)}\n`, 'utf8');
    }

    /** The leaf on disk, read once; afterwards what this process issued. */
    #leafFacts(): LeafFacts | null {
        if (this.#leaf !== undefined) return this.#leaf;
        const certPem = readText(this.#leafCert);
        const keyPem = readText(this.#leafKey);
        this.#leaf = null;
        if (certPem !== null && keyPem !== null) {
            try {
                const leaf = new X509Certificate(certPem);
                const fromCa = leaf.checkIssued(this.#cert) && leaf.verify(this.#cert.publicKey) && spki(createPrivateKey(keyPem)).equals(leaf.publicKey.export({ type: 'spki', format: 'der' }));
                this.#leaf = { hosts: dnsNames(leaf), notAfter: Date.parse(leaf.validTo), fromCa };
            } catch {
                this.#leaf = null;
            }
        }
        return this.#leaf;
    }
}

/** The OS trust store, asked whether it holds a certificate with this thumbprint. Read-only. */
export interface TrustStorePort {
    has(thumbprint: string): Promise<boolean>;
}

export type CommandRun = (command: string, args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>;

/**
 * OS-store identifiers, matching X509Certificate.fingerprint and the Windows/macOS SHA-1 thumbprints.
 * This read-only presence lookup controls the Trust prompt; it does not authenticate a peer or
 * sign a certificate. x509.ts signs certificates with SHA-256. Keep existing store/adoption IDs
 * compatible: changing this hash alone would make an already-trusted CA appear absent.
 */
export function pemThumbprints(bundle: string): string[] {
    const out: string[] = [];
    for (const m of bundle.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)) {
        const der = Buffer.from((m[1] ?? '').replace(/\s+/g, ''), 'base64');
        out.push(createHash('sha1').update(der).digest('hex').toUpperCase());
    }
    return out;
}

export function osTrustStore(platform: NodeJS.Platform, run: CommandRun, read: (path: string) => string | null = (p) => (existsSync(p) ? readText(p) : null)): TrustStorePort {
    return {
        has: async (thumbprint) => {
            const t = normaliseThumbprint(thumbprint);
            const query = trustQuery(platform, t);
            if (query.kind === 'bundles') {
                return query.paths.some((p) => {
                    const bundle = read(p);
                    return bundle !== null && pemThumbprints(bundle).includes(t);
                });
            }
            const r = await run(query.command, query.args);
            if (r.exitCode !== 0) throw new Error(`${query.command} ${query.args[0] ?? ''} exited ${r.exitCode}: ${r.stdout.trim().slice(0, 300)}`);
            return trustAnswer(platform, r.stdout, t);
        },
    };
}
