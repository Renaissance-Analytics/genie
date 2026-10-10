import { randomBytes } from 'node:crypto';
import type { AcpProvider } from './engine.js';

/**
 * ONE ID, MINTED ONCE, USED BY EVERY SUBSYSTEM.
 *
 * Session store, mail, roster, capacity accounting, UI lookup, persistence, file
 * attribution — all of them key off this and nothing derives a second.
 *
 * ## Why this file exists at all
 *
 * The previous build split the identity: one id was written and a different one read. That
 * is the whole reason its Conversation tab was unreachable for four releases. The failure
 * mode is the expensive kind — **nothing throws**. The writer succeeds, the reader succeeds,
 * and the UI renders a correct, empty session forever while every surface downstream gets
 * blamed first.
 *
 * The branded type makes a raw string unusable as an id by accident, so the only way to get
 * one is to mint it or to read one that was minted.
 */
declare const AgentIdBrand: unique symbol;

export type AgentId = string & { readonly [AgentIdBrand]: true };

export function mintAgentId(): AgentId {
    return `agent_${randomBytes(16).toString('hex')}` as AgentId;
}

/** Narrow a stored string back to an id. Rejects anything this module did not mint. */
export function asAgentId(value: string): AgentId | null {
    return /^agent_[0-9a-f]{32}$/.test(value) ? (value as AgentId) : null;
}

/**
 * The durable-store key for an agent's thread.
 *
 * **This is the only function that turns an agent into a storage key.** Both the writer and
 * the reader call it; there is no second shape anywhere, and a review that finds one has
 * found the bug described above. It is deliberately trivial — the value is not in what it
 * computes but in there being exactly one of it.
 */
export function threadKeyFor(id: AgentId): string {
    return `genie:agent:${id}:thread`;
}

/**
 * What persists about an agent.
 *
 * **No pty, no shell, no args, no launch line, no command string.** The previous build stored
 * `agent_command`, decided the engine by testing whether that string was a bare provider
 * invocation, and so routed every agent carrying flags — which was all of them — onto a
 * terminal. The absence of that field is load-bearing, and `AGENT_RECORD_FIELDS` plus its
 * test exist to keep it absent.
 *
 * How an agent is launched is a property of its PROVIDER and is resolved at launch time by
 * `prism-acp`. It is not configuration, and it is not this record's business.
 */
export interface AgentRecord {
    readonly id: AgentId;
    readonly workspaceId: string;
    readonly provider: AcpProvider;
    /** The human-facing name. Identity is the NAME, never the provider or a session id. */
    readonly name: string;
    /** Path to the committed persona, e.g. `.agents/atlas/AGENT.md`. */
    readonly instructions: string | null;
    /**
     * The provider-side conversation this agent resumes into.
     *
     * `null` means **it has never run** — which is a different claim from an empty thread,
     * and the UI must be able to tell them apart. Never collapse the two.
     */
    readonly threadId: string | null;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
    /**
     * Changes how Genie WORDS its notices to this agent and nothing else.
     *
     * **Not a permission boundary.** It restricts nothing, is not a security control, and
     * nothing may be built on it as though it were.
     */
    readonly mode: 'automated' | 'manual';
    /** Who may discover and message this agent. */
    readonly accessScope: 'none' | 'self' | 'specific' | 'all';
}

/** The record's own field list, so a test can assert the shape rather than trusting prose. */
export const AGENT_RECORD_FIELDS = [
    'id', 'workspaceId', 'provider', 'name', 'instructions',
    'threadId', 'createdAt', 'lastUsedAt', 'mode', 'accessScope',
] as const satisfies readonly (keyof AgentRecord)[];

export interface NewAgent {
    id: AgentId;
    workspaceId: string;
    provider: AcpProvider;
    name: string;
    instructions?: string | null;
    /** Defaults to `manual` — see the field doc. */
    mode?: AgentRecord['mode'];
    accessScope?: AgentRecord['accessScope'];
    now?: () => string;
}

export function agentRecord(input: NewAgent): AgentRecord {
    const now = input.now ?? (() => new Date().toISOString());
    return {
        id: input.id,
        workspaceId: input.workspaceId,
        provider: input.provider,
        name: input.name,
        instructions: input.instructions ?? null,
        threadId: null,
        createdAt: now(),
        lastUsedAt: null,
        mode: input.mode ?? 'manual',
        accessScope: input.accessScope ?? 'self',
    };
}
