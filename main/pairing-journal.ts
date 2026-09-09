import fs from 'node:fs';
import path from 'node:path';
import { isSecretKey } from './debug-log';

/**
 * A small, durable record of everything that drops a pairing.
 *
 * WHY THIS EXISTS. Genie writes no application log. Every way a pairing can be
 * lost — the host's session store failing to decrypt, the client's saved token
 * failing to decrypt, no keychain to decrypt either with, the host rejecting a
 * token it no longer knows — used to be silent, and all four presented to the
 * user as the same "enter the PIN again". Nobody, user or developer, could
 * answer "why does this keep happening?" (genie#578), and the answer died with
 * the process that knew it.
 *
 * The loss happens ACROSS a restart — an upgrade, a reboot, a keychain that
 * wasn't up yet — so stderr and an in-memory buffer are both useless: the thing
 * you need to read is written by the process that is already gone. Hence a
 * file, next to the stores it is about.
 *
 * WHAT IT IS NOT: application logging, or telemetry. It records pairing
 * lifecycle decisions only, it is bounded, it never leaves the machine, and it
 * carries NO secrets — a file we ask a user to hand over must be safe to hand
 * over, so detail keys are redacted by the same name-based rule the startup
 * debug log uses (`isSecretKey`), which is deliberately over-broad.
 */

/** Which half of the pairing an event came from. */
export type PairingSide = 'host' | 'client';

/**
 * The stable event vocabulary. These strings are the whole point — they are
 * what makes the four silent paths distinguishable — so they are spelled out
 * here rather than free-formed at each call site.
 */
export type PairingEventCode =
    // Host side (`genie-mobile.json`: the PIN + every paired device).
    | 'host-store-restored'
    | 'host-store-absent'
    | 'host-store-unreadable'
    | 'host-store-preserved'
    | 'host-store-not-persisted'
    // Client side (`genie-remote-tokens.json`: one session token per host).
    | 'client-token-saved'
    | 'client-token-not-saved'
    | 'client-token-missing'
    | 'client-token-unreadable'
    | 'client-token-rejected';

/** Small, non-secret facts about one event (a host key, a reason, a count). */
export type PairingDetail = Record<string, string | number | boolean | null | undefined>;

export interface PairingEventInput {
    side: PairingSide;
    event: PairingEventCode;
    detail?: PairingDetail;
}

export interface PairingEvent {
    /** ISO-8601, so the file is readable without tooling. */
    at: string;
    side: PairingSide;
    event: PairingEventCode;
    detail: Record<string, string | number | boolean | null>;
}

/** How many entries to keep. Enough to span several boots and an upgrade;
 *  small enough that the file stays hand-readable and can never grow without
 *  bound in a directory nobody looks at. */
export const PAIRING_JOURNAL_MAX = 200;

const FILE_NAME = 'genie-pairing-journal.jsonl';

let dir: string | null = null;

/** Point the journal at the user-data directory (the composition root does this
 *  once at boot; the mobile server repeats it so a headless host is
 *  self-sufficient). Pass null to disable. */
export function setPairingJournalDir(next: string | null): void {
    dir = next;
}

/** The journal file, or null when no directory has been set. */
export function pairingJournalPath(): string | null {
    return dir ? path.join(dir, FILE_NAME) : null;
}

/**
 * The pairing PIN, which `isSecretKey` has no reason to know about — it is an
 * ENV-VAR rule, and no environment variable is called `pin`. Deliberately a
 * bare substring: this file's whole subject is pairing, the detail vocabulary
 * is small and written here, so any key containing "pin" is the PIN, and the
 * cost of a false positive is one redacted diagnostic.
 */
function isPairingSecretKey(key: string): boolean {
    return /pin/i.test(key);
}

/** Strip anything whose KEY says it could be a secret. Name-based, like the
 *  startup log's: a value-shaped heuristic misses a token that happens to look
 *  ordinary, and the key is the part we control. */
function redact(detail: PairingDetail): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(detail)) {
        if (value === undefined) continue;
        out[key] = isSecretKey(key) || isPairingSecretKey(key) ? '<redacted>' : value;
    }
    return out;
}

/**
 * Append one event. Never throws: a journal that breaks the pairing it is
 * recording would be worse than no journal at all.
 */
export function recordPairingEvent(input: PairingEventInput): void {
    const file = pairingJournalPath();
    if (!file) return;
    const entry: PairingEvent = {
        at: new Date().toISOString(),
        side: input.side,
        event: input.event,
        detail: redact(input.detail ?? {}),
    };
    try {
        const existing = readRawLines(file);
        // Trim on write rather than on a timer: the file is only touched a
        // handful of times per boot, so the cost is nothing and there is no
        // background job to fail silently.
        const lines = [...existing, JSON.stringify(entry)].slice(-PAIRING_JOURNAL_MAX);
        fs.writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch {
        /* best-effort — never let the journal break what it is recording */
    }
}

/** The raw JSONL lines that parse, oldest first. A garbled line is dropped
 *  rather than costing us the whole journal. */
function readRawLines(file: string): string[] {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    return raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => {
            if (!l) return false;
            try {
                JSON.parse(l);
                return true;
            } catch {
                return false;
            }
        });
}

/** The journal, oldest first. Empty when there is none. */
export function readPairingJournal(): PairingEvent[] {
    const file = pairingJournalPath();
    if (!file) return [];
    return readRawLines(file).map((l) => JSON.parse(l) as PairingEvent);
}

/** Reset module state (test-only). */
export function _resetPairingJournalForTest(): void {
    dir = null;
}
