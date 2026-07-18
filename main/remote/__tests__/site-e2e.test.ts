import {
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    sign,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
    completeSiteKey,
    initiateSiteKey,
    SitePayloadCipher,
} from '../site-e2e';
import type { Frame } from '../relay-protocol';

function transcript(
    sid: string,
    workstationId: string,
    memberPublicKey: string,
    hostPublicKey: string,
    nonce: string,
): Buffer {
    return Buffer.from(
        `genie-site-e2e-v1\n${sid}\n${workstationId}\n${memberPublicKey}\n${hostPublicKey}\n${nonce}`,
    );
}

describe('blind relay site encryption', () => {
    it('authenticates the enrolled host and hides path, headers, and body', () => {
        const identity = generateKeyPairSync('ed25519');
        const ephemeral = generateKeyPairSync('x25519');
        const { init, pending } = initiateSiteKey();
        const hostPublicKey = ephemeral.publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64');
        const sid = 'sid_1';
        const workstationId = 'ws_1';
        const accept = {
            type: 'site-key-accept' as const,
            publicKey: hostPublicKey,
            signature: sign(
                null,
                transcript(sid, workstationId, init.publicKey, hostPublicKey, init.nonce),
                identity.privateKey,
            ).toString('base64'),
        };
        const member = completeSiteKey(pending, accept, {
            sid,
            workstationId,
            hostPublicKeyB64: identity.publicKey
                .export({ type: 'spki', format: 'der' })
                .toString('base64'),
        });
        const actualShared = diffieHellman({
            privateKey: ephemeral.privateKey,
            publicKey: createPublicKey({
                key: Buffer.from(init.publicKey, 'base64'),
                type: 'spki',
                format: 'der',
            }),
        });
        const material = Buffer.from(
            hkdfSync(
                'sha256',
                actualShared,
                Buffer.from(init.nonce, 'base64'),
                Buffer.from(`genie-site-e2e-v1\n${sid}\n${workstationId}`),
                64,
            ),
        );
        const host = new SitePayloadCipher(material.subarray(32), material.subarray(0, 32));
        const frame: Frame = {
            kind: 'open',
            channel: 'site',
            sid,
            reqId: 'req_1',
            payload: {
                workspaceId: 'secret-workspace',
                siteId: 'secret-site',
                method: 'POST',
                path: '/private?token=secret',
                headers: { authorization: 'Bearer secret' },
                body: 'secret-body',
            },
        };

        const sealed = member.seal(frame);
        expect(JSON.stringify(sealed)).not.toContain('secret');
        expect(host.open(sealed)).toEqual(frame);
    });

    it('rejects tampering and replay', () => {
        const keyA = Buffer.alloc(32, 1);
        const keyB = Buffer.alloc(32, 2);
        const sender = new SitePayloadCipher(keyA, keyB);
        const receiver = new SitePayloadCipher(keyB, keyA);
        const frame: Frame = {
            kind: 'data',
            channel: 'site',
            sid: 'sid',
            reqId: 'req',
            payload: { t: 'body', data: 'c2VjcmV0' },
        };
        const sealed = sender.seal(frame);
        expect(receiver.open(sealed)).toEqual(frame);
        expect(() => receiver.open(sealed)).toThrow(/sequence/);
        expect(() => {
            const fresh = new SitePayloadCipher(keyB, keyA);
            fresh.open({ ...sealed, reqId: 'other' });
        }).toThrow();
    });
});
