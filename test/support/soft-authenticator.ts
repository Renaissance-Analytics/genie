import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A SOFTWARE WEBAUTHN AUTHENTICATOR for unit tests (Tynn #677): what a platform authenticator returns to the page, built
 * by hand to the WebAuthn spec (§6.1 authenticator data, §6.5.4 attested credential data, `none` attestation, ES256), so
 * the host's real verifier (fancy-passkeys over @simplewebauthn/server) checks real signatures. Each response names the
 * origin the "page" was on and the rpId it asked for, so a test can make one from the wrong page or for the wrong rpId.
 * Test-only: it lives under test/ and nothing in src imports it.
 */

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();

/** The CBOR this needs (RFC 8949): unsigned/negative ints, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
    const head = (major: number, n: number): Buffer => {
        if (n < 24) return Buffer.from([(major << 5) | n]);
        if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
        if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
        const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
    };
    if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
    if (typeof value === 'string') { const t = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, t.length), t]); }
    if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
    if (value instanceof Map) {
        const parts: Buffer[] = [head(5, value.size)];
        for (const [k, v] of value) parts.push(cbor(k), cbor(v));
        return Buffer.concat(parts);
    }
    throw new Error(`cbor: ${typeof value}`);
}

export interface CreationOptions { challenge: string; rp: { id?: string }; user: { id: string } }
export interface RequestOptions { challenge: string; rpId?: string }

export class SoftAuthenticator {
    readonly credentialId = randomBytes(16);
    readonly #key: KeyObject;
    readonly #publicJwk: { x: string; y: string };
    counter = 0;
    userHandle: string | null = null;

    constructor() {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        this.#key = privateKey;
        const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
        this.#publicJwk = { x: jwk.x, y: jwk.y };
    }

    get id(): string { return b64u(this.credentialId); }

    #authData(rpId: string, attested: boolean): Buffer {
        // UP | UV, and AT when a credential is attested.
        const flags = 0x01 | 0x04 | (attested ? 0x40 : 0);
        const count = Buffer.alloc(4);
        count.writeUInt32BE(this.counter, 0);
        const parts = [sha256(rpId), Buffer.from([flags]), count];
        if (attested) {
            const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.#publicJwk.x, 'base64url')], [-3, Buffer.from(this.#publicJwk.y, 'base64url')]]));
            const len = Buffer.alloc(2);
            len.writeUInt16BE(this.credentialId.length, 0);
            parts.push(Buffer.alloc(16), len, this.credentialId, cose);
        }
        return Buffer.concat(parts);
    }

    /** navigator.credentials.create's answer, as JSON (`toJSON()`), from a page on `origin`, for `rpId`. */
    create(options: CreationOptions, page: { origin: string; rpId?: string }) {
        const rpId = page.rpId ?? options.rp.id ?? '';
        this.userHandle = options.user.id;
        const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: page.origin, crossOrigin: false }));
        const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.#authData(rpId, true)]]));
        return {
            id: this.id, rawId: this.id, type: 'public-key' as const, clientExtensionResults: {}, authenticatorAttachment: 'platform' as const,
            response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
        };
    }

    /** navigator.credentials.get's answer. The counter goes up by one unless `counter` says what to sign. */
    get(options: RequestOptions, page: { origin: string; rpId?: string; counter?: number }) {
        const rpId = page.rpId ?? options.rpId ?? '';
        this.counter = page.counter ?? this.counter + 1;
        const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: page.origin, crossOrigin: false }));
        const authenticatorData = this.#authData(rpId, false);
        const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.#key);
        return {
            id: this.id, rawId: this.id, type: 'public-key' as const, clientExtensionResults: {}, authenticatorAttachment: 'platform' as const,
            response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), ...(this.userHandle ? { userHandle: this.userHandle } : {}) },
        };
    }
}
