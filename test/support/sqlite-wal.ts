import { readFileSync } from 'node:fs';

/**
 * A GAUGE FOR DURABLE COMMITS — how many transactions a SQLite database in WAL mode has committed since its log was
 * started, read from the log file itself (`<db>-wal`), while a connection still holds the database open (the last
 * close checkpoints the log and deletes it).
 *
 * Why a count and not a clock (B13): every WAL commit is a sync of the log to disk, and under a parallel suite those
 * syncs queue behind everything else being written on the machine. A timing assertion would be the flake it is meant
 * to catch; the NUMBER of commits is deterministic, and it is the thing that costs.
 *
 * The format (sqlite.org/fileformat.html §4.1): a 32-byte header — magic, version, page size, checkpoint sequence,
 * salt-1, salt-2, two checksums, big-endian — then frames of a 24-byte header and one page. A frame's bytes 4–7 are
 * the database size after the commit for a COMMIT frame and 0 for any other; a frame belongs to the current log only
 * when its two salts equal the header's.
 */
export interface WalCount {
    /** Frames (pages written) in the current log. */
    readonly frames: number;
    /** Commit frames: transactions committed into the current log — one durable sync each. */
    readonly commits: number;
}

const MAGIC = new Set([0x377f0682, 0x377f0683]);

export function walCommits(dbFile: string): WalCount {
    const wal = readFileSync(`${dbFile}-wal`);
    if (wal.length < 32) throw new Error(`${dbFile}-wal is ${wal.length} bytes: no WAL header to read`);
    if (!MAGIC.has(wal.readUInt32BE(0))) throw new Error(`${dbFile}-wal does not start with a WAL magic number`);
    const pageSize = wal.readUInt32BE(8);
    const salt1 = wal.readUInt32BE(16);
    const salt2 = wal.readUInt32BE(20);
    const frameSize = 24 + pageSize;
    let frames = 0;
    let commits = 0;
    for (let at = 32; at + frameSize <= wal.length; at += frameSize) {
        if (wal.readUInt32BE(at + 8) !== salt1 || wal.readUInt32BE(at + 12) !== salt2) break;
        frames += 1;
        if (wal.readUInt32BE(at + 4) !== 0) commits += 1;
    }
    return { frames, commits };
}
