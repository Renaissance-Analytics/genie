import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createSecureContext, type SecureContext } from 'node:tls';
import { certificateVerdict, type CertificateFacts, type CertificateVerdict } from '../core/browser-origins.js';
import type { GenRoute } from '../core/gen-router.js';

/**
 * THE GENIE BROWSER'S TRUST IN GENIE'S CA (S7) — the crypto half; the decisions are core/browser-origins.ts's.
 *
 * - `genCertificateVerifier`: what the pane session's `setCertificateVerifyProc` answers. It reads the presented
 *   certificate (Electron's `request.certificate.data`, PEM) against Genie's CA: a LEAF whose signature verifies with
 *   the CA's public key, naming the host, in date. Never a blanket accept, and only ever for `.gen` hosts.
 * - `GenLeafContexts`: the TLS context the in-app front door terminates `CONNECT <name>.gen:443` with — Genie's leaf
 *   for the current routes, from the same `GenCa` that writes the external Caddy's leaf, so there is one leaf, not two.
 */

export interface PresentedCertificate {
    readonly hostname: string;
    /** PEM, as Electron's Certificate structure carries it (`data`). */
    readonly certificatePem: string;
}

/** Built once per CA. A CA that does not parse throws here, at wiring time — not on the first page load. */
export function genCertificateVerifier(caPem: string, now: () => number = Date.now): (presented: PresentedCertificate) => CertificateVerdict {
    const ca = new X509Certificate(caPem);
    if (!ca.ca) throw new Error('the certificate given as Genie’s CA is not a CA');
    return ({ hostname, certificatePem }) => certificateVerdict(hostname, factsOf(ca, certificatePem, hostname, now()));
}

function factsOf(ca: X509Certificate, pem: string, hostname: string, at: number): CertificateFacts | null {
    let leaf: X509Certificate;
    try {
        leaf = new X509Certificate(pem);
    } catch {
        return null;
    }
    let signed = false;
    try {
        // checkIssued compares the issuer NAME (an impostor CA can copy it); verify proves the SIGNATURE is the CA key's.
        signed = !leaf.ca && leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
    } catch {
        signed = false;
    }
    let names = false;
    try {
        names = leaf.checkHost(hostname.toLowerCase(), { wildcards: false, subject: 'never' }) !== undefined;
    } catch {
        names = false;
    }
    const inDate = at >= Date.parse(leaf.validFrom) && at <= Date.parse(leaf.validTo);
    return { signedByGenieCa: signed, namesHost: names, inDate };
}

/** The part of `GenCa` this needs: the leaf for a host set, issued when it changed (main/gen-ca.ts `leafFor`). */
export interface LeafSource {
    leafFor(hosts: readonly string[]): { readonly certPath: string; readonly keyPath: string };
}

export class GenLeafContexts {
    readonly #ca: LeafSource;
    readonly #routes: () => readonly GenRoute[];
    #cached: { certPem: string; context: SecureContext } | null = null;

    constructor(ca: LeafSource, routes: () => readonly GenRoute[]) {
        this.#ca = ca;
        this.#routes = routes;
    }

    /**
     * The context for a tunnel to `host`, or `null` when no running site has that name. The leaf names every route, so
     * one context serves them all; it is rebuilt when the certificate on disk is a different one (compared by content,
     * never by mtime — a coarse clock can give two writes the same stamp).
     */
    forHost(host: string): SecureContext | null {
        const hosts = this.#routes().map((r) => r.host);
        if (!hosts.includes(host)) return null;
        const leaf = this.#ca.leafFor(hosts);
        const certPem = readFileSync(leaf.certPath, 'utf8');
        if (this.#cached?.certPem !== certPem) this.#cached = { certPem, context: createSecureContext({ cert: certPem, key: readFileSync(leaf.keyPath, 'utf8') }) };
        return this.#cached.context;
    }
}
