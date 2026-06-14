import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Terminal session snapshots (Tier 1 persistence).
 *
 * A snapshot is the renderer's xterm SerializeAddon output — a clean ANSI
 * reconstruction of the visible buffer + scrollback. We persist it so that
 * after a full app quit + relaunch the terminal can replay its history,
 * draw a "— previous session —" divider, reset, then start a fresh shell.
 *
 * On-disk shape, per terminal id, at `userData/sessions/<id>.snap`:
 *
 *   [1 byte magic]  0x01 = safeStorage-encrypted, 0x00 = plaintext fallback
 *   [gzip payload]  gzip( utf8( serialized ) )   (encrypted as a whole when magic=0x01)
 *
 * Encryption posture mirrors the GitHub token storage (main/github/storage.ts):
 * Electron `safeStorage` wraps the OS keychain (DPAPI / Keychain / libsecret).
 * When the OS can't encrypt (rare; headless Linux without libsecret) we fall
 * back to writing the gzip payload in the clear with the 0x00 marker and log
 * ONCE — a terminal scrollback is far less sensitive than an auth token, and a
 * non-functional resume would be worse than a plaintext scrollback on disk.
 *
 * Every read path tolerates missing / truncated / corrupt files by returning
 * null — a bad snapshot must never block a terminal from spawning.
 */

/** Trim snapshots to this many bytes of serialized text, keeping the TAIL
 *  (most-recent output). ~256 KB is plenty for a screen + deep scrollback and
 *  bounds both disk and the replay write. */
const MAX_SERIALIZED_BYTES = 256 * 1024;

const MAGIC_ENCRYPTED = 0x01;
const MAGIC_PLAINTEXT = 0x00;

/** Log the safeStorage-unavailable fallback at most once per process. */
let warnedNoEncryption = false;

export interface SnapshotRead {
    serialized: string;
    /** Epoch ms the file was last written (from its mtime). */
    savedAt: number;
}

function sessionsDir(): string {
    const dir = path.join(app.getPath('userData'), 'sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function snapPath(id: string): string {
    // ids are renderer-minted ulids (see lib/genie.ts) — alnum, no separators —
    // but guard anyway so a hostile/garbage id can never escape the dir.
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
    return path.join(sessionsDir(), `${safe}.snap`);
}

function encryptionAvailable(): boolean {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

/** Keep the last N bytes of a UTF-8 string without splitting a surrogate pair
 *  at the cut boundary. */
function trimTail(serialized: string): string {
    const buf = Buffer.from(serialized, 'utf8');
    if (buf.length <= MAX_SERIALIZED_BYTES) return serialized;
    // Decode the tail slice; Buffer→string on a mid-codepoint boundary yields a
    // replacement char rather than corruption, which xterm renders harmlessly.
    return buf.subarray(buf.length - MAX_SERIALIZED_BYTES).toString('utf8');
}

/**
 * Persist a snapshot for `id`. Returns the on-disk byte size (so the caller
 * can record `snapshot_bytes`), or null when nothing was written (empty
 * input or an I/O error — never throws).
 */
export function writeSnapshot(id: string, serialized: string): number | null {
    try {
        if (!serialized) return null;
        const trimmed = trimTail(serialized);
        const gz = zlib.gzipSync(Buffer.from(trimmed, 'utf8'));

        let body: Buffer;
        let magic: number;
        if (encryptionAvailable()) {
            magic = MAGIC_ENCRYPTED;
            body = safeStorage.encryptString(gz.toString('base64'));
        } else {
            if (!warnedNoEncryption) {
                warnedNoEncryption = true;
                // eslint-disable-next-line no-console
                console.warn(
                    '[sessions] OS encryption unavailable — writing terminal ' +
                        'snapshots as plaintext gzip. Install libsecret/gnome-keyring ' +
                        'on Linux to encrypt them at rest.',
                );
            }
            magic = MAGIC_PLAINTEXT;
            body = gz;
        }

        const out = Buffer.concat([Buffer.from([magic]), body]);
        // Atomic-ish write: tmp + rename so a crash mid-write can't leave a
        // half-file that the next read would mistake for a real snapshot.
        const target = snapPath(id);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, target);
        return out.length;
    } catch {
        return null;
    }
}

/**
 * Read a snapshot for `id`, or null when absent / unreadable / corrupt.
 * Never throws.
 */
export function readSnapshot(id: string): SnapshotRead | null {
    try {
        const file = snapPath(id);
        const stat = fs.statSync(file); // throws if missing → caught → null
        const raw = fs.readFileSync(file);
        if (raw.length < 2) return null;

        const magic = raw[0];
        const body = raw.subarray(1);

        let gz: Buffer;
        if (magic === MAGIC_ENCRYPTED) {
            if (!encryptionAvailable()) return null;
            const b64 = safeStorage.decryptString(body);
            gz = Buffer.from(b64, 'base64');
        } else if (magic === MAGIC_PLAINTEXT) {
            gz = body;
        } else {
            return null; // unknown format
        }

        const serialized = zlib.gunzipSync(gz).toString('utf8');
        return { serialized, savedAt: stat.mtimeMs };
    } catch {
        return null;
    }
}

/** Best-effort delete. Never throws; a missing file is success. */
export function deleteSnapshot(id: string): void {
    try {
        fs.rmSync(snapPath(id), { force: true });
    } catch {
        /* ignore */
    }
}
