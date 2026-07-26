import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only audit log for the mobile remote-control server.
 *
 * The user's security posture is "free once paired + kill-switch": a paired
 * phone acts freely (real remote use), but every state-changing remote action is
 * recorded here, and the baton (baton.ts) decides who may act at all.
 *
 * - **Audit log** — every remote action (terminal write/create/kill, process
 *   start/stop/restart, question answer, pairing, control transfer) is appended
 *   as one JSON line to `<userData>/genie-mobile-audit.log`. Append-only by
 *   contract: we only ever `appendFileSync`, never truncate or rewrite. Capped
 *   in memory for the live tail the Settings UI shows; the file keeps the full
 *   history.
 * - **Attribution** — a workstation's agents run on the OWNER's credentials
 *   whoever is driving, so the log records WHO drove: the acting principal's id
 *   plus their emoji signature (see emoji.ts). Reading the trail you can tell
 *   🦊's commands from 🐢's even though both spent the same credentials.
 * - **Control state** lives in baton.ts — `isLocked()`/`setLocked()` moved there
 *   when the two-principal kill-switch became the N-user baton.
 */

/** Who performed an action: a principal id plus its attribution signature. */
export interface AuditActor {
    /** Stable principal id (mobile session id, Tynn user id, or 'desktop'). */
    id: string;
    /** The principal's attribution emoji, when known. */
    emoji?: string;
    /** Display name, for a readable trail. */
    name?: string;
}

/** One recorded remote action. */
export interface AuditEntry {
    /** ISO timestamp. */
    at: string;
    /** Coarse action kind (terminal.write, process.start, question.answer, …). */
    action: string;
    /** Free-form detail (terminal id, command preview, question id, …). */
    detail?: string;
    /** The principal id that performed it (session id prefix), or 'desktop'. */
    by?: string;
    /** The performer's emoji signature — WHO drove, at a glance. */
    emoji?: string;
    /** The performer's display name, when known. */
    byName?: string;
}

let logPath: string | null = null;

/** In-memory tail of recent entries for the Settings live view (newest last). */
const recent: AuditEntry[] = [];
const RECENT_CAP = 200;

/** Point the audit log at `<userData>/genie-mobile-audit.log`. Idempotent. */
export function initAudit(userDataDir: string): void {
    logPath = path.join(userDataDir, 'genie-mobile-audit.log');
}

/**
 * Append one action to the audit log (append-only; best-effort file write).
 *
 * `actor` is the driving principal — pass the full `AuditActor` so the entry
 * carries their emoji signature. A bare string is still accepted for the host's
 * own actions ('desktop') and legacy call sites.
 */
export function audit(action: string, detail?: string, actor?: string | AuditActor): void {
    const by = typeof actor === 'string' ? actor : actor?.id;
    const entry: AuditEntry = {
        at: new Date().toISOString(),
        action,
        detail,
        by,
        ...(typeof actor === 'object' && actor
            ? { emoji: actor.emoji, byName: actor.name }
            : {}),
    };
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

/** Reset module state (test-only). */
export function _resetAuditForTest(): void {
    recent.length = 0;
    logPath = null;
}
