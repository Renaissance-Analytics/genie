import {
    createCipheriv,
    createDecipheriv,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    verify,
    type KeyObject,
} from 'node:crypto';

import type { Frame } from './relay-protocol';

const VERSION = 1;
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;

export interface SiteKeyInit {
    type: 'site-key-init';
    publicKey: string;
    nonce: string;
}

export interface SiteKeyAccept {
    type: 'site-key-accept';
    publicKey: string;
    signature: string;
}

interface PendingSiteKey {
    privateKey: KeyObject;
    init: SiteKeyInit;
}

interface SealedPayload {
    e2e: { v: 1; seq: number; iv: string; data: string; tag: string };
}

function transcript(
    sid: string,
    workstationId: string,
    memberPublicKey: string,
    hostPublicKey: string,
    nonce: string,
): Buffer {
    return Buffer.from(
        `genie-site-e2e-v1\n${sid}\n${workstationId}\n${memberPublicKey}\n${hostPublicKey}\n${nonce}`,
        'utf8',
    );
}

function aad(frame: Pick<Frame, 'kind' | 'channel' | 'sid' | 'reqId' | 'code' | 'reason'>, seq: number): Buffer {
    return Buffer.from(
        JSON.stringify([
            VERSION,
            frame.kind,
            frame.channel,
            frame.sid,
            frame.reqId ?? '',
            frame.code ?? '',
            frame.reason ?? '',
            seq,
        ]),
        'utf8',
    );
}

function deriveKeys(shared: Buffer, nonce: Buffer, sid: string, workstationId: string): {
    memberToHost: Buffer;
    hostToMember: Buffer;
} {
    const info = Buffer.from(`genie-site-e2e-v1\n${sid}\n${workstationId}`, 'utf8');
    const material = Buffer.from(hkdfSync('sha256', shared, nonce, info, 64));
    return { memberToHost: material.subarray(0, 32), hostToMember: material.subarray(32) };
}

export class SitePayloadCipher {
    private sendSequence = 0;
    private receiveSequence = 0;

    constructor(
        private readonly sendKey: Buffer,
        private readonly receiveKey: Buffer,
    ) {}

    seal(frame: Frame): Frame {
        if (frame.channel !== 'site') return frame;
        const seq = ++this.sendSequence;
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv);
        cipher.setAAD(aad(frame, seq));
        const data = Buffer.concat([
            cipher.update(Buffer.from(JSON.stringify({ payload: frame.payload }), 'utf8')),
            cipher.final(),
        ]);
        const payload: SealedPayload = {
            e2e: {
                v: VERSION,
                seq,
                iv: iv.toString('base64'),
                data: data.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
            },
        };
        return { ...frame, payload };
    }

    open(frame: Frame): Frame {
        if (frame.channel !== 'site') return frame;
        const wrapped = frame.payload as Partial<SealedPayload>;
        const envelope = wrapped?.e2e;
        if (!envelope || envelope.v !== VERSION || !Number.isSafeInteger(envelope.seq)) {
            throw new Error('site frame is not end-to-end encrypted');
        }
        if (
            typeof envelope.iv !== 'string' ||
            typeof envelope.data !== 'string' ||
            typeof envelope.tag !== 'string' ||
            envelope.data.length > Math.ceil(MAX_CIPHERTEXT_BYTES * 4 / 3) + 4
        ) {
            throw new Error('site ciphertext envelope is invalid');
        }
        if (envelope.seq !== this.receiveSequence + 1) {
            throw new Error('site frame sequence is invalid');
        }
        const decipher = createDecipheriv(
            'aes-256-gcm',
            this.receiveKey,
            Buffer.from(envelope.iv, 'base64'),
        );
        decipher.setAAD(aad(frame, envelope.seq));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.data, 'base64')),
            decipher.final(),
        ]);
        this.receiveSequence = envelope.seq;
        const decoded = JSON.parse(plaintext.toString('utf8')) as { payload?: unknown };
        const opened = { ...frame, payload: decoded.payload };
        if (!Object.prototype.hasOwnProperty.call(decoded, 'payload')) delete opened.payload;
        return opened;
    }
}

export function initiateSiteKey(): { init: SiteKeyInit; pending: PendingSiteKey } {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const init: SiteKeyInit = {
        type: 'site-key-init',
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        nonce: randomBytes(32).toString('base64'),
    };
    return { init, pending: { privateKey, init } };
}

export function completeSiteKey(
    pending: PendingSiteKey,
    accept: SiteKeyAccept,
    opts: { sid: string; workstationId: string; hostPublicKeyB64: string },
): SitePayloadCipher {
    const hostIdentity = createPublicKey({
        key: decodeFixedBase64(opts.hostPublicKeyB64, 44, 'host identity key'),
        type: 'spki',
        format: 'der',
    });
    const signed = transcript(
        opts.sid,
        opts.workstationId,
        pending.init.publicKey,
        accept.publicKey,
        pending.init.nonce,
    );
    if (!verify(null, signed, hostIdentity, decodeFixedBase64(accept.signature, 64, 'host signature'))) {
        throw new Error('site E2E host identity signature is invalid');
    }
    const hostEphemeral = createPublicKey({
        key: decodeFixedBase64(accept.publicKey, 44, 'host ephemeral key'),
        type: 'spki',
        format: 'der',
    });
    const keys = deriveKeys(
        diffieHellman({ privateKey: pending.privateKey, publicKey: hostEphemeral }),
        Buffer.from(pending.init.nonce, 'base64'),
        opts.sid,
        opts.workstationId,
    );
    return new SitePayloadCipher(keys.memberToHost, keys.hostToMember);
}

function decodeFixedBase64(value: string, bytes: number, label: string): Buffer {
    if (typeof value !== 'string' || value.length > 128) throw new Error(`invalid ${label}`);
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== bytes) throw new Error(`invalid ${label}`);
    return decoded;
}
