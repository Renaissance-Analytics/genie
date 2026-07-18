import { createPublicKey, verify } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
    clearWorkstationIdentity,
    buildWorkstationAuthHeader,
    ensureLocalWorkstation,
    fingerprintSpki,
    generateHostKeypair,
    readWorkstationIdentity,
    storeWorkstationIdentity,
    type HostKeypair,
    type WorkstationEnroller,
} from '../workstation-identity';

const PROOF_CONTEXT = 'workstation-auth';

/** Reconstruct the Ed25519 public KeyObject from the SPKI DER base64 we enroll. */
function publicKeyFromSpkiB64(spkiB64: string) {
    return createPublicKey({
        key: Buffer.from(spkiB64, 'base64'),
        format: 'der',
        type: 'spki',
    });
}

describe('generateHostKeypair', () => {
    it('produces a PKCS8 PEM private key and an SPKI-DER-base64 public key that pair', () => {
        const { privateKeyPem, publicKeySpkiB64 } = generateHostKeypair();

        expect(privateKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
        // Round-trips to a usable Ed25519 public key (throws if the encoding is wrong).
        const pub = publicKeyFromSpkiB64(publicKeySpkiB64);
        expect(pub.asymmetricKeyType).toBe('ed25519');

        // A signature made with the private key verifies under the derived public key.
        const header = buildWorkstationAuthHeader(privateKeyPem, 'ws-1', 1_700_000_000_000);
        const [ts, sig] = header.replace(/^Workstation /, '').split(':');
        const msg = Buffer.from(`${PROOF_CONTEXT}\nws-1\n${ts}`, 'utf8');
        expect(verify(null, msg, pub, Buffer.from(sig, 'base64'))).toBe(true);
    });
});

describe('buildWorkstationAuthHeader', () => {
    it('signs `workstation-auth\\n{id}\\n{ts}` and formats `Workstation <ts>:<sig>`', () => {
        const { privateKeyPem, publicKeySpkiB64 } = generateHostKeypair();
        const now = 1_700_000_123_456; // ms
        const expectedTs = Math.floor(now / 1000);

        const header = buildWorkstationAuthHeader(privateKeyPem, 'ws-42', now);

        expect(header).toMatch(new RegExp(`^Workstation ${expectedTs}:[A-Za-z0-9+/=]+$`));
        const [ts, sig] = header.replace(/^Workstation /, '').split(':');
        expect(ts).toBe(String(expectedTs));

        const pub = publicKeyFromSpkiB64(publicKeySpkiB64);
        const good = Buffer.from(`${PROOF_CONTEXT}\nws-42\n${expectedTs}`, 'utf8');
        expect(verify(null, good, pub, Buffer.from(sig, 'base64'))).toBe(true);

        // A tampered id / ts / context does NOT verify against the same signature.
        const wrongId = Buffer.from(`${PROOF_CONTEXT}\nws-99\n${expectedTs}`, 'utf8');
        expect(verify(null, wrongId, pub, Buffer.from(sig, 'base64'))).toBe(false);
        const wrongTs = Buffer.from(`${PROOF_CONTEXT}\nws-42\n${expectedTs + 1}`, 'utf8');
        expect(verify(null, wrongTs, pub, Buffer.from(sig, 'base64'))).toBe(false);
    });

    it('is deterministic for a fixed key + id + ts (Ed25519 is deterministic)', () => {
        const { privateKeyPem } = generateHostKeypair();
        const a = buildWorkstationAuthHeader(privateKeyPem, 'ws-1', 1_700_000_000_000);
        const b = buildWorkstationAuthHeader(privateKeyPem, 'ws-1', 1_700_000_000_000);
        expect(a).toBe(b);
    });
});

describe('fingerprintSpki', () => {
    it('is a stable 64-hex-char SHA-256 of the DER public key', () => {
        const { publicKeySpkiB64 } = generateHostKeypair();
        const fp = fingerprintSpki(publicKeySpkiB64);
        expect(fp).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprintSpki(publicKeySpkiB64)).toBe(fp);
    });
});

describe('readWorkstationIdentity', () => {
    it('returns null when no id / no key is persisted', () => {
        expect(readWorkstationIdentity(() => ({}))).toBeNull();
        expect(readWorkstationIdentity(() => ({ id: 'ws-1' }))).toBeNull();
        expect(readWorkstationIdentity(() => ({ keyEnc: 'blob' }))).toBeNull();
    });
});

describe('ensureLocalWorkstation', () => {
    function fakeBackend(): WorkstationEnroller & {
        selfRegisterWorkstation: ReturnType<typeof vi.fn>;
        enrollWorkstation: ReturnType<typeof vi.fn>;
    } {
        return {
            selfRegisterWorkstation: vi.fn(async (name: string) => ({
                workstation: { id: 'ws-new', name, status: 'pending' },
                enrollment: { workstation_id: 'ws-new', secret: 's3cr3t', expires_at: null },
            })),
            enrollWorkstation: vi.fn(async () => ({
                workstation: { id: 'ws-new', name: 'host', status: 'active' },
            })),
        };
    }

    it('no-ops when an identity already exists (idempotent)', async () => {
        const backend = fakeBackend();
        const store = vi.fn();
        const res = await ensureLocalWorkstation(backend, {
            readIdentity: () => ({ workstationId: 'ws-existing', authHeader: () => 'Workstation 1:sig' }),
            storeIdentity: store,
        });
        expect(res).toEqual({ status: 'exists', workstationId: 'ws-existing' });
        expect(backend.selfRegisterWorkstation).not.toHaveBeenCalled();
        expect(backend.enrollWorkstation).not.toHaveBeenCalled();
        expect(store).not.toHaveBeenCalled();
    });

    it('self-registers, enrolls the SPKI public key, then persists the identity', async () => {
        const backend = fakeBackend();
        const store = vi.fn();
        const keypair: HostKeypair = generateHostKeypair();

        const res = await ensureLocalWorkstation(backend, {
            readIdentity: () => null,
            hostname: () => 'my-machine',
            generateKeypair: () => keypair,
            storeIdentity: store,
        });

        expect(res).toEqual({ status: 'enrolled', workstationId: 'ws-new' });
        expect(backend.selfRegisterWorkstation).toHaveBeenCalledWith('my-machine');
        expect(backend.enrollWorkstation).toHaveBeenCalledWith(
            'ws-new',
            's3cr3t',
            keypair.publicKeySpkiB64,
            fingerprintSpki(keypair.publicKeySpkiB64),
        );
        // Persist ONLY after enroll — with the id + the raw PEM (storage encrypts it).
        expect(store).toHaveBeenCalledWith('ws-new', keypair.privateKeyPem);
    });

    it('does NOT persist an identity when enroll fails (clean retry next boot)', async () => {
        const backend = fakeBackend();
        backend.enrollWorkstation.mockRejectedValueOnce(new Error('410 gone'));
        const store = vi.fn();

        await expect(
            ensureLocalWorkstation(backend, {
                readIdentity: () => null,
                generateKeypair: () => generateHostKeypair(),
                storeIdentity: store,
            }),
        ).rejects.toThrow('410 gone');
        expect(store).not.toHaveBeenCalled();
    });
});

describe('storeWorkstationIdentity', () => {
    it('throws (fail-closed) rather than persisting when OS encryption is unavailable', () => {
        // No secrets encryptor is installed in the vitest process, so
        // secretEncryptionAvailable() is false and the store must refuse to write.
        const write = vi.fn();
        expect(() => storeWorkstationIdentity('ws-1', 'PEM', write)).toThrow(/encryption is unavailable/);
        expect(write).not.toHaveBeenCalled();
    });
});

describe('clearWorkstationIdentity', () => {
    it('clears both persisted identity fields so the next ensure re-enrolls', () => {
        const write = vi.fn();
        clearWorkstationIdentity(write);
        expect(write).toHaveBeenCalledWith({
            workstation_id: '',
            workstation_key_enc: '',
        });
    });
});
