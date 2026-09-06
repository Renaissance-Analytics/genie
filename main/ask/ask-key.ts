/**
 * The ForceTheQuestion RE-ATTACH key — what makes an interrupted ask REJOINABLE.
 *
 * An agent's ask can be cut off between raising the question and receiving the
 * answer: the MCP session drops, the agent is restarted, Genie itself restarts.
 * Before this, the only thing the agent could do on reconnect was ask again —
 * and a re-ask was indistinguishable from a new question. The user saw the same
 * question twice, answered one of them, and the agent that asked twice got one
 * answer for two asks it was tracking.
 *
 * The key is DERIVED here from the ASKING TERMINAL plus the question content,
 * and is never accepted from the agent. That is a safety property, not an
 * implementation preference. A key the agent chose could be reused across two
 * genuinely different questions — by carelessness or deliberately — and the two
 * would silently collapse into one row: the user would answer one question
 * believing they had answered both, and the second agent would receive an
 * answer to a question it never asked. `terminalId` is resolved by the host
 * (`server.ts` reads it, `caller-identity` binds it), so neither half of the
 * key is under the caller's control.
 *
 * PURE: no electron, no db, no state. Only `crypto`.
 */

import crypto from 'crypto';
import type { ForceQuestion } from '../mcp/protocol';

/**
 * The canonical text of one question — the fields the modal actually RENDERS,
 * emitted in a fixed order.
 *
 * Fixed order is the whole point: `JSON.stringify` preserves insertion order, so
 * hashing the agent's object directly would make the key depend on the key order
 * of the JSON it sent. A reconnecting agent re-serializes its arguments and can
 * easily emit the same content in a different order — it would then fail to
 * rejoin its own question, for a reason it can neither see nor fix.
 *
 * Anything NOT listed here is not question content and cannot fork the key:
 * `priority` (the same question asked more urgently is the same question), the
 * workspace label, and any stray property riding along on the arguments.
 */
function canonicalQuestion(q: ForceQuestion): unknown[] {
    return [
        String(q.header ?? ''),
        String(q.question ?? ''),
        q.multiSelect === true,
        (Array.isArray(q.options) ? q.options : []).map((o) => [
            String(o?.label ?? ''),
            String(o?.description ?? ''),
        ]),
    ];
}

/**
 * The re-attach key for an ask: `sha256(terminalId, canonical questions)`.
 *
 * Order-sensitive across the BATCH — a different ordering of the same questions
 * is a different modal to answer, so it is a different ask.
 */
export function deriveAskKey(terminalId: string, questions: ForceQuestion[]): string {
    const canonical = JSON.stringify([
        String(terminalId),
        (Array.isArray(questions) ? questions : []).map(canonicalQuestion),
    ]);
    return crypto.createHash('sha256').update(canonical).digest('hex');
}
