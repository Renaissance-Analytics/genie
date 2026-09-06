/**
 * The DURABLE mirror of the pending-question queue.
 *
 * `force-question.ts` keeps the live queue in memory, which is right — the modal
 * reads it on every keystroke. But in-memory was ALL there was, so an upgrade, a
 * crash or a killed process took every pending question with it: the agent that
 * asked was left waiting on an answer that could never arrive, and the human
 * never learned a question had existed. Genie upgrades constantly, so that was
 * not a rare edge; it was most weeks.
 *
 * This is the mirror that lets the queue be rebuilt afterwards. It stores only
 * what a question must be REBUILT from, and only for questions that can still be
 * answered after the restart — see `rehydratePendingQuestions` for who that is.
 *
 * Every method is FAIL-SAFE. All of them run on the path that raises a question:
 * losing the durable copy is bad, failing to ask the user is worse. A database
 * that is missing, locked, or not yet initialised costs the backup, never the
 * question.
 */

import type Database from 'better-sqlite3';
import {
    deletePendingQuestion,
    getDb,
    listPendingQuestionRecords,
    upsertPendingQuestion,
    type PendingQuestionRecord,
} from '../db';
import type { ForceQuestion } from '../mcp/protocol';
import type { QuestionPriority } from './question-priority';
import type { DeferralReason } from './force-question';

/** A pending question in the shape `force-question` thinks in. */
export interface PersistedQuestion {
    id: string;
    /** The derived re-attach key (`main/ask/ask-key.ts`) — UNIQUE in the table. */
    askKey: string;
    /** The asking agent's terminal: who the answer goes back to. */
    terminalId: string;
    questions: ForceQuestion[];
    workspaceId?: string;
    workspaceLabel?: string;
    workspacePath?: string;
    priority?: QuestionPriority;
    /** True when it sits in the inbox rather than the modal queue. */
    deferred: boolean;
    deferralReason?: DeferralReason;
    /** Arrival time (ms epoch) — so a rebuilt inbox can still say "3h ago". */
    createdAt: number;
}

/** The seam `force-question` writes through. Injected so the queue is testable
 *  without a database, and so a headless shell can substitute its own. */
export interface QuestionStorePort {
    /** Store or update one question. Storing a key that already belongs to a
     *  DIFFERENT pending question is refused, not duplicated. */
    save(q: PersistedQuestion): void;
    /** Forget one — answered, cancelled or retracted. */
    remove(id: string): void;
    /** Everything still stored, oldest first. */
    load(): PersistedQuestion[];
}

const PRIORITIES = new Set<string>(['low', 'normal', 'high', 'urgent']);
const REASONS = new Set<string>(['dnd', 'unshowable', 'restart']);

/**
 * Rebuild one stored row, or null when it cannot be trusted.
 *
 * A row is only useful if its QUESTIONS survive, so an unparseable
 * `questions_json` drops that row — and only that row. The alternative, letting
 * one bad row throw out of `load()`, would cost every other pending question in
 * the table for a fault none of them had.
 */
function fromRecord(r: PendingQuestionRecord): PersistedQuestion | null {
    let questions: unknown;
    try {
        questions = JSON.parse(r.questions_json);
    } catch {
        return null;
    }
    if (!Array.isArray(questions) || questions.length === 0) return null;
    return {
        id: r.id,
        askKey: r.ask_key,
        terminalId: r.terminal_id,
        questions: questions as ForceQuestion[],
        ...(r.workspace_id ? { workspaceId: r.workspace_id } : {}),
        ...(r.workspace_label ? { workspaceLabel: r.workspace_label } : {}),
        ...(r.workspace_path ? { workspacePath: r.workspace_path } : {}),
        ...(r.priority && PRIORITIES.has(r.priority)
            ? { priority: r.priority as QuestionPriority }
            : {}),
        deferred: r.deferred === 1,
        ...(r.deferral_reason && REASONS.has(r.deferral_reason)
            ? { deferralReason: r.deferral_reason as DeferralReason }
            : {}),
        createdAt: r.created_at,
    };
}

function toRecord(q: PersistedQuestion): PendingQuestionRecord {
    return {
        id: q.id,
        ask_key: q.askKey,
        terminal_id: q.terminalId,
        questions_json: JSON.stringify(q.questions),
        workspace_id: q.workspaceId ?? null,
        workspace_label: q.workspaceLabel ?? null,
        workspace_path: q.workspacePath ?? null,
        priority: q.priority ?? null,
        deferred: q.deferred ? 1 : 0,
        deferral_reason: q.deferralReason ?? null,
        created_at: q.createdAt,
    };
}

/**
 * Build a store over a database resolver. `getDatabase` is a function rather
 * than a handle because the desktop opens the database during boot and this
 * module is imported before that: resolving per call means an early save fails
 * safely instead of the whole module failing to load.
 */
export function makeQuestionStore(
    getDatabase: () => Database.Database,
): QuestionStorePort {
    return {
        save(q) {
            try {
                upsertPendingQuestion(getDatabase(), toRecord(q));
            } catch {
                /* The durable copy is a backup. Never take the question down. */
            }
        },
        remove(id) {
            try {
                deletePendingQuestion(getDatabase(), id);
            } catch {
                /* Same: a stale row is recoverable, a lost answer is not. */
            }
        },
        load() {
            try {
                return listPendingQuestionRecords(getDatabase())
                    .map(fromRecord)
                    .filter((q): q is PersistedQuestion => q !== null);
            } catch {
                return [];
            }
        },
    };
}

/** The store the desktop and the headless host both use: the real genie.db. */
export const dbQuestionStore: QuestionStorePort = makeQuestionStore(() => getDb());
