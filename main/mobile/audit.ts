import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only audit log + the global kill-switch for the mobile remote-control
 * server.
 *
 * The user's security posture is "free once paired + kill-switch": a paired
 * phone acts freely (real remote use), but every state-changing remote action is
 * recorded here, and a single global lock can sever ALL remote control at once.
 *
 * - **Audit log** — every remote action (terminal write/create/kill, process
 *   start/stop/restart, question answer, pairing, lock/unlock) is appended as
 *   one JSON line to `<userData>/genie-mobile-audit.log`. Append-only by
 *   contract: we only ever `appendFileSync`, never truncate or rewrite. Capped
 *   in memory for the live tail the Settings UI shows; the file keeps the full
 *   history.
 * - **Kill-switch (`lock`)** — when engaged, the REST/WS handlers refuse every
 *   state-changing action (and the desktop can drop sessions). A module-level
 *   flag the handlers check on each request, so it takes effect immediately
 *   without restarting the server. Distinct from revoking sessions (auth.ts):
 *   lock is a fast "freeze everything" the user can toggle; revoke invalidates
 *   tokens so the phone must re-pair.
 */

/** One recorded remote action. */
export interface AuditEntry {
    /** ISO timestamp. */
    at: string;
    /** Coarse action kind (terminal.write, process.start, question.answer, …). */
    action: string;
    /** Free-form detail (terminal id, command preview, question id, …). */
    detail?: string;
    /** The session token id (first 8 chars) that performed it, or 'desktop'. */
    by?: string;
}

let logPath: string | null = null;

/** In-memory tail of recent entries for the Settings live view (newest last). */
const recent: AuditEntry[] = [];
const RECENT_CAP = 200;

/** The global kill-switch. When true, all remote state-changing actions refuse. */
let locked = false;

/** Point the audit log at `<userData>/genie-mobile-audit.log`. Idempotent. */
export function initAudit(userDataDir: string): void {
    logPath = path.join(userDataDir, 'genie-mobile-audit.log');
}

/** Append one action to the audit log (append-only; best-effort file write). */
export function audit(action: string, detail?: string, by?: string): void {
    const entry: AuditEntry = { at: new Date().toISOString(), action, detail, by };
    recent.push(entry);
    if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP);
    if (!logPath) return;
    try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    } catch {
        /* best-effort — a failed audit write must never break the action path */
    }
}

/** The recent in-memory tail (newest last), for the Settings audit view. */
export function recentAudit(): AuditEntry[] {
    return recent.slice();
}

/** True when the global kill-switch is engaged (handlers refuse on true). */
export function isLocked(): boolean {
    return locked;
}

/** Engage / release the global kill-switch. Audited. */
export function setLocked(value: boolean): void {
    if (locked === value) return;
    locked = value;
    audit(value ? 'lock.engage' : 'lock.release', undefined, 'desktop');
}

/** Reset module state (test-only). */
export function _resetAuditForTest(): void {
    recent.length = 0;
    locked = false;
    logPath = null;
}
