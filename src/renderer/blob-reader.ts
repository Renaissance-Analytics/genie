import { BLOB_READ_BYTES, type BlobCalls, type BlobClient } from '../core/local-blobs.js';
import { decodeLocalBase64 } from './local-base64.js';

/** Uses the caller's existing connection, with no family consumer or additional transport. */
export function verifiedBlobClient(port: BlobCalls): BlobClient {
    return { ...port, readAll: async (kind, ref) => {
        const opened = await port.open(kind, ref);
        let failed = false;
        try {
            if (!opened || typeof opened.id !== 'string' || !Number.isSafeInteger(opened.size) || opened.size < 0 || typeof opened.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(opened.sha256)) throw new Error('invalid blob metadata');
            const bytes = new Uint8Array(opened.size);
            for (let offset = 0; offset < opened.size; offset += BLOB_READ_BYTES) {
                const length = Math.min(BLOB_READ_BYTES, opened.size - offset), chunk = await port.read(opened.id, offset, length);
                if (!chunk || typeof chunk.base64 !== 'string' || chunk.base64.length !== 4 * Math.ceil(length / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.base64)) throw new Error('invalid base64 in a blob read');
                const decoded = decodeLocalBase64(chunk.base64);
                if (decoded === null || decoded.byteLength !== length) throw new Error('invalid base64 length in a blob read');
                bytes.set(decoded, offset);
            }
            const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
            const sha256 = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
            if (sha256 !== opened.sha256.toLowerCase()) throw new Error('the blob SHA-256 hash does not match its content');
            return bytes;
        } catch (error) { failed = true; throw error; }
        finally {
            if (opened && typeof opened.id === 'string') {
                try { await port.close(opened.id); }
                catch (error) { if (!failed) throw error; console.warn('[genie] a local blob could not be released after its read failed'); }
            }
        }
    } };
}
