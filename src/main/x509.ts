import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';

/**
 * A SMALL X.509 v3 BUILDER on node:crypto — Node can read and verify certificates (`X509Certificate`) but not build
 * them, and Genie needs exactly two kinds: its local CA and the one `.gen` leaf. Genie 1 assembled them with
 * node-forge and signed the TBS with Node (forge's own signer produced malformed signatures under load, genie#78);
 * here the assembly is ~a hundred lines of DER, so Genie 2 takes no dependency for it. Keys are generated, and every
 * signature made, by OpenSSL through node:crypto; verification stays on `X509Certificate`.
 *
 * Only what the two certificates use is encoded: INTEGER, OID, UTF8String, IA5String SANs, UTCTime/GeneralizedTime,
 * BOOLEAN, BIT/OCTET STRING, SEQUENCE/SET and explicit tags. RSA (sha256WithRSAEncryption) and EC (ecdsa-with-SHA256)
 * signing keys are accepted — Genie 1's CA key is RSA in PKCS#1, new keys are RSA-2048 in PKCS#8.
 */

export interface IssuedPem {
    readonly certPem: string;
    readonly keyPem: string;
}

function length(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    const bytes: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const TRUE = tlv(0x01, Buffer.from([0xff]));
const NULL = Buffer.from([0x05, 0x00]);

/** A positive INTEGER, minimally encoded: leading zero bytes dropped, one put back only when the top bit is set. */
function integer(bytes: Buffer): Buffer {
    let b = bytes;
    while (b.length > 1 && b[0] === 0) b = b.subarray(1);
    if (((b[0] ?? 0) & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(0x02, b);
}

function oid(dotted: string): Buffer {
    const parts = dotted.split('.').map(Number);
    const out: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
    for (const n of parts.slice(2)) {
        const chunk = [n & 0x7f];
        for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
        out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5); seconds, Zulu. */
function time(d: Date): Buffer {
    const full = `${d.toISOString().slice(0, 19).replace(/[-:T]/g, '')}Z`;
    const year = d.getUTCFullYear();
    return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(full.slice(2), 'ascii')) : tlv(0x18, Buffer.from(full, 'ascii'));
}

function name(attrs: { commonName: string; organization?: string }): Buffer {
    const rdn = (type: string, value: string) => set(seq(oid(type), tlv(0x0c, Buffer.from(value, 'utf8'))));
    return seq(rdn('2.5.4.3', attrs.commonName), ...(attrs.organization ? [rdn('2.5.4.10', attrs.organization)] : []));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
    return seq(oid(id), ...(critical ? [TRUE] : []), tlv(0x04, value));
}

/** keyUsage as a DER named BIT STRING: trailing zero bits dropped and counted as unused. */
function keyUsage(bits: readonly number[]): Buffer {
    const max = Math.max(...bits);
    const bytes = Buffer.alloc(Math.floor(max / 8) + 1);
    for (const bit of bits) {
        const i = Math.floor(bit / 8);
        bytes[i] = (bytes[i] ?? 0) | (0x80 >> (bit % 8));
    }
    return tlv(0x03, Buffer.concat([Buffer.from([7 - (max % 8)]), bytes]));
}

const KU = { digitalSignature: 0, keyEncipherment: 2, keyCertSign: 5, cRLSign: 6 } as const;

function signatureAlgorithm(key: KeyObject): Buffer {
    if (key.asymmetricKeyType === 'rsa') return seq(oid('1.2.840.113549.1.1.11'), NULL);
    if (key.asymmetricKeyType === 'ec') return seq(oid('1.2.840.10045.4.3.2'));
    throw new Error(`a ${key.asymmetricKeyType ?? 'unknown'} key cannot sign Genie’s certificates (RSA or EC only)`);
}

/** 16 random bytes with the top bit clear and the first byte non-zero: positive and minimal by construction (genie#78). */
function serial(): Buffer {
    const b = randomBytes(16);
    b[0] = ((b[0] ?? 1) & 0x7f) || 0x01;
    return b;
}

function toPem(der: Buffer): string {
    const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function build(spec: { subject: Buffer; issuer: Buffer; publicKey: KeyObject; signer: KeyObject; notBefore: Date; notAfter: Date; extensions: Buffer[] }): string {
    const algorithm = signatureAlgorithm(spec.signer);
    const tbs = seq(
        tlv(0xa0, integer(Buffer.from([2]))),
        integer(serial()),
        algorithm,
        spec.issuer,
        seq(time(spec.notBefore), time(spec.notAfter)),
        spec.subject,
        spec.publicKey.export({ type: 'spki', format: 'der' }),
        tlv(0xa3, seq(...spec.extensions)),
    );
    const signature = sign('sha256', tbs, spec.signer);
    return toPem(seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))));
}

function newRsaKey(): { privateKey: KeyObject; keyPem: string } {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { privateKey, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

interface Node {
    readonly tag: number;
    readonly start: number;
    readonly body: number;
    readonly end: number;
}

function readNode(buf: Buffer, at: number): Node {
    const tag = buf[at];
    const first = buf[at + 1];
    if (tag === undefined || first === undefined) throw new Error('truncated DER');
    let body = at + 2;
    let len = first;
    if (first >= 0x80) {
        len = 0;
        for (let i = 0; i < (first & 0x7f); i++) len = len * 256 + (buf[body + i] ?? 0);
        body += first & 0x7f;
    }
    if (body + len > buf.length) throw new Error('truncated DER');
    return { tag, start: at, body, end: body + len };
}

function childrenOf(buf: Buffer, node: Node): Node[] {
    const out: Node[] = [];
    for (let at = node.body; at < node.end; ) {
        const child = readNode(buf, at);
        out.push(child);
        at = child.end;
    }
    return out;
}

/**
 * A certificate's subject Name, byte for byte. The leaf's issuer is the CA's subject COPIED, never re-encoded: chain
 * building compares the encoded names, and Genie 1's CA (forge) need not have encoded its strings the way this file does.
 */
export function subjectDer(certDer: Buffer): Buffer {
    const tbs = childrenOf(certDer, readNode(certDer, 0))[0];
    if (!tbs) throw new Error('not a certificate');
    const fields = childrenOf(certDer, tbs);
    const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
    const subject = fields[offset + 4];
    if (!subject || subject.tag !== 0x30) throw new Error('certificate has no subject');
    return certDer.subarray(subject.start, subject.end);
}

/** A self-signed CA: basicConstraints cA (critical), keyUsage keyCertSign + cRLSign (critical) — Genie 1's extensions. */
export function issueCa(spec: { commonName: string; organization: string; notBefore: Date; notAfter: Date }): IssuedPem {
    const { privateKey, keyPem } = newRsaKey();
    const subject = name(spec);
    const certPem = build({
        subject,
        issuer: subject,
        publicKey: createPublicKey(privateKey),
        signer: privateKey,
        notBefore: spec.notBefore,
        notAfter: spec.notAfter,
        extensions: [extension('2.5.29.19', true, seq(TRUE)), extension('2.5.29.15', true, keyUsage([KU.keyCertSign, KU.cRLSign]))],
    });
    return { certPem, keyPem };
}

/**
 * The server leaf for every name in `hosts` (CN = the first), signed by `ca`: basicConstraints not-a-CA, keyUsage
 * digitalSignature + keyEncipherment, extKeyUsage serverAuth, subjectAltName dNSName per host. A fresh key each time.
 */
export function issueLeaf(ca: IssuedPem, hosts: readonly string[], notBefore: Date, notAfter: Date): IssuedPem {
    const first = hosts[0];
    if (first === undefined) throw new Error('a leaf needs at least one name');
    const caCert = new X509Certificate(ca.certPem);
    const signer = createPrivateKey(ca.keyPem);
    const { privateKey, keyPem } = newRsaKey();
    const certPem = build({
        subject: name({ commonName: first }),
        issuer: subjectDer(caCert.raw),
        publicKey: createPublicKey(privateKey),
        signer,
        notBefore,
        notAfter,
        extensions: [
            extension('2.5.29.19', false, seq()),
            extension('2.5.29.15', false, keyUsage([KU.digitalSignature, KU.keyEncipherment])),
            extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
            extension('2.5.29.17', false, seq(...hosts.map((h) => tlv(0x82, Buffer.from(h, 'ascii'))))),
        ],
    });
    return { certPem, keyPem };
}
