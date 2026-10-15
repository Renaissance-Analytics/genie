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

/**
 * What a CLAUDE agent may do. Read when its session starts; absent = `all`.
 * - `all` — every tool runs without asking (`--permission-mode bypassPermissions`);
 * - `ask` — every tool runs, but a SHELL command (`Bash`) waits for the person's answer in the chat first, and runs
 *   only on an explicit allow once (prism-acp's `permissionPrompts`, raised as `onRequestPermission`);
 * - `edits` — file edits go through; shell commands are refused (`--permission-mode acceptEdits`).
 */
export type AgentPermissions = 'all' | 'edits' | 'ask';

export function mintAgentId(): AgentId {
    return `agent_${randomBytes(16).toString('hex')}` as AgentId;
}

/** Narrow a stored string back to an id. Rejects anything this module did not mint. */
export function asAgentId(value: string): AgentId | null {
    return /^agent_[0-9a-f]{32}$/.test(value) ? (value as AgentId) : null;
}

/**
 * The OS agent's name — the one agent that belongs to no workspace, and the one name that is also an
 * ADDRESS: the rail links `genie://agent/genie` because the OS agent's id is minted on first boot and
 * the rail cannot know it.
 */
export const OS_AGENT_NAME = 'genie';

/**
 * Narrow a reference from the renderer: a minted id, or exactly the OS agent's name. The registry turns
 * the name into the record; nothing else is accepted (a refusal, never a repair).
 */
export function asAgentRef(value: string): AgentId | typeof OS_AGENT_NAME | null {
    if (value === OS_AGENT_NAME) return OS_AGENT_NAME;
    return asAgentId(value);
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
    /**
     * What a CLAUDE agent may do: `all` tools, `ask` the person before shell commands, or file `edits` only — shell
     * refused (see `AgentPermissions`). Absent = `all`, so every agent registered before this field existed can still
     * run its tools.
     */
    readonly permissions?: AgentPermissions;
    /**
     * The model this agent's provider is started with — a name the provider accepts: Claude's `sonnet` / `opus` /
     * `haiku` or a full model id, Codex's model id. Absent = the provider's own default. Read when its session starts.
     * What the provider actually RUNS is reported separately (`LiveSession.model`) and may differ.
     */
    readonly model?: string;
    /** Who may discover and message this agent. */
    readonly accessScope: 'none' | 'self' | 'specific' | 'all';
    /**
     * A daily dollar limit (§6.2) that parks the NEXT turn and asks — never kills one in flight.
     * OPTIONAL and not in AGENT_RECORD_FIELDS, so records written before it exist still load.
     * No provider reports a cost over ACP today, so it is shown as unenforceable until one does.
     */
    readonly dailyBudgetUsd?: number | null;
    /**
     * The agent this one is the SIDECAR of (§6.2): `<agent>-slave`, registered by that agent as its own
     * review partner. OPTIONAL and not in AGENT_RECORD_FIELDS for the same reason as the budget. Genie
     * never stops a sidecar for you: nothing links the parent's stop to this record.
     */
    readonly sidecarOf?: AgentId | null;
}

/**
 * Whether a stored thread id is one Genie is willing to hand to a provider.
 *
 * ## This value is UNTRUSTED, and it does not look it
 *
 * The id originates with the provider: the CLI emits it, prism-acp passes it through as
 * `_meta["particle.academy/cli_session_id"]` with `typeof === "string"` as the only check,
 * Genie persists it, and on reattach it goes back as `resumeSessionId` — which prism-acp puts
 * **straight into argv** (`--resume <id>`). On Windows it spawns with `shell: true`, because
 * npm installs CLIs as `.cmd` shims and Node refuses to spawn one otherwise (the
 * CVE-2024-27980 fix), and **cmd.exe interprets `&`, `|` and `&&` inside arguments** — the
 * prism maintainer measured `a&echo PWNED` executing.
 *
 * So the chain is: provider output → a meta field → a JSON file → a command line. By the time
 * it reaches `spawn` it is three hops from looking like provider output, and **being stored is
 * what makes it read as configuration instead of as input.** Data does not stop being
 * attacker-influenced because it has been written down.
 *
 * ## An ALLOWLIST
 *
 * Not a list of metacharacters to reject. Quoting rules differ per shell and per OS, and a
 * blocklist is a bet that nobody will ever find a character you forgot. Everything a real
 * provider actually reports fits inside this: a UUID, `stub_thread_0001`, `sess-ABC.123:7` —
 * all measured, not imagined. A guard that rejects a real session id breaks every resume,
 * which is why the accepting test uses ids taken off the wire.
 *
 * prism-acp owns the quoting and is fixing it. This stays after that lands: a value we hand to
 * another process is ours to keep well-formed, and defence in depth is the only kind that
 * survives somebody else's refactor.
 */
const RESUMABLE_THREAD_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function threadIdIsResumable(value: string): boolean {
    return RESUMABLE_THREAD_ID.test(value);
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
    sidecarOf?: AgentId | null;
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
        ...(input.sidecarOf ? { sidecarOf: input.sidecarOf } : {}),
    };
}
