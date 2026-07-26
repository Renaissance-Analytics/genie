import { audit } from './audit';
import { mobileEmitEach } from './bus';
import { DESKTOP_EMOJI } from './emoji';

/**
 * The BATON — who may drive this host right now.
 *
 * This is the host's original kill-switch grown up. That switch was already a
 * two-principal baton: either the desktop had control (every remote view-only) or
 * it didn't. A Tynn-managed workstation runs on ONE set of credentials but may be
 * driven by SEVERAL people, so the same seam now tracks N principals:
 *
 *   - **Exactly one driver.** At most one principal holds the baton; everyone else
 *     is view-only. `authorizeDrive()` is the single gate every state-changing
 *     remote path goes through (REST 423, dropped `/ws/term` input).
 *   - **Owners TAKE, others are GIVEN.** An owner may take the baton off whoever
 *     holds it. A non-owner may never take — the holder must hand it over
 *     (`give`), or they may claim it while it is FREE (nobody is interrupted).
 *   - **The desktop is just another principal** (`DESKTOP_PRINCIPAL`, always an
 *     owner). `setLocked(true)` is the desktop taking the baton and `isLocked()`
 *     is "the desktop holds it" — the exact old kill-switch contract, now one case
 *     of the general rule rather than a parallel mechanism.
 *
 * The pure core (`decideBaton`) holds no state and does no I/O, so every transfer
 * rule is unit-testable; the live registry below is a thin wrapper that keeps one
 * `BatonState`, records transfers in the audit log, and pushes `control:changed`
 * to each connected client with THAT client's view of who is driving.
 */

/** The local desktop/host owner — the principal the kill-switch has always been. */
export const DESKTOP_PRINCIPAL = 'desktop';

/** One principal that can drive the host: a connected user, or the desktop. */
export interface BatonPrincipal {
    /** Stable id — the mobile session id, a Tynn user id, or DESKTOP_PRINCIPAL. */
    id: string;
    /** Display name for the connected-users list. */
    name: string;
    /** The attribution emoji stamped on everything this principal drives. */
    emoji: string;
    /** Owners may TAKE the baton; everyone else can only be GIVEN it. */
    isOwner: boolean;
    /** Connected-since (epoch ms), for the roster. */
    since: number;
}

/** Who is connected and who is driving. Treated as immutable by the pure core. */
export interface BatonState {
    /** The principal id holding the baton, or null when it is free. */
    holder: string | null;
    participants: readonly BatonPrincipal[];
}

export type BatonRequest =
    /** A principal connected (or reconnected — identity is refreshed). */
    | { kind: 'join'; principal: BatonPrincipal }
    /** A principal disconnected. Frees the baton if they were holding it. */
    | { kind: 'leave'; id: string }
    /** Seize the baton. Owner-only while someone else holds it. */
    | { kind: 'take'; by: string }
    /** Hand the baton to another connected principal. Holder-only. */
    | { kind: 'give'; from: string; to: string }
    /** Drop the baton, leaving it free. Holder-only. */
    | { kind: 'release'; by: string }
    /** Drive something. Allowed for the holder; claims a FREE baton. */
    | { kind: 'drive'; by: string };

export interface BatonDecision {
    /** Whether the request is permitted. */
    allowed: boolean;
    /** The resulting state (the input state unchanged when refused). */
    state: BatonState;
    /** Why it was refused — surfaced to the caller (423/403 body). */
    reason?: string;
    /** True when `state` differs from the input (drives the control:changed push). */
    changed: boolean;
}

/** A baton with nobody connected and nobody driving. */
export function emptyBaton(): BatonState {
    return { holder: null, participants: [] };
}

/** Whether `id` currently holds the baton. */
export function holdsBaton(state: BatonState, id: string | null | undefined): boolean {
    return id != null && state.holder === id;
}

function find(state: BatonState, id: string): BatonPrincipal | undefined {
    return state.participants.find((p) => p.id === id);
}

function refuse(state: BatonState, reason: string): BatonDecision {
    return { allowed: false, state, reason, changed: false };
}

function allow(state: BatonState, next: BatonState): BatonDecision {
    const changed =
        next.holder !== state.holder || next.participants !== state.participants;
    return { allowed: true, state: next, changed };
}

/**
 * The transfer rules, as a pure function. Refusals never mutate the state, so a
 * denied take/give can't leave the baton in a half-transferred spot.
 */
export function decideBaton(state: BatonState, req: BatonRequest): BatonDecision {
    switch (req.kind) {
        case 'join': {
            const existing = find(state, req.principal.id);
            // A reconnect refreshes identity (name/emoji may have changed in Tynn)
            // but must NOT disturb the baton — dropping a page shouldn't cost you
            // control you already hold.
            const participants = existing
                ? state.participants.map((p) =>
                      p.id === req.principal.id ? { ...req.principal, since: p.since } : p,
                  )
                : [...state.participants, req.principal];
            return allow(state, { holder: state.holder, participants });
        }

        case 'leave': {
            if (!find(state, req.id)) return { allowed: true, state, changed: false };
            return allow(state, {
                holder: state.holder === req.id ? null : state.holder,
                participants: state.participants.filter((p) => p.id !== req.id),
            });
        }

        case 'take': {
            const by = find(state, req.by);
            if (!by) return refuse(state, 'not connected');
            if (state.holder === by.id) return { allowed: true, state, changed: false };
            // A free baton is CLAIMED, not taken — nobody is being interrupted, so
            // the owner-only rule doesn't apply.
            if (state.holder !== null && !by.isOwner) {
                const holder = find(state, state.holder);
                return refuse(
                    state,
                    `${holder?.name ?? 'someone else'} has control — only an owner can take it; ask them to hand it over`,
                );
            }
            return allow(state, { holder: by.id, participants: state.participants });
        }

        case 'give': {
            if (state.holder !== req.from) {
                return refuse(state, 'only the user holding control can hand it over');
            }
            if (!find(state, req.to)) return refuse(state, 'that user is not connected');
            return allow(state, { holder: req.to, participants: state.participants });
        }

        case 'release': {
            if (state.holder !== req.by) {
                return refuse(state, 'only the user holding control can release it');
            }
            return allow(state, { holder: null, participants: state.participants });
        }

        case 'drive': {
            const by = find(state, req.by);
            if (!by) return refuse(state, 'not connected');
            if (state.holder === by.id) return { allowed: true, state, changed: false };
            if (state.holder !== null) {
                const holder = find(state, state.holder);
                return refuse(
                    state,
                    holder?.id === DESKTOP_PRINCIPAL
                        ? 'the desktop has control'
                        : `${holder?.name ?? 'another user'} has control`,
                );
            }
            return allow(state, { holder: by.id, participants: state.participants });
        }
    }
}

// --- live registry ---------------------------------------------------------

let live: BatonState = emptyBaton();

/** The desktop principal — lazily materialised the first time it takes control. */
function desktopPrincipal(): BatonPrincipal {
    return {
        id: DESKTOP_PRINCIPAL,
        name: 'This computer',
        emoji: DESKTOP_EMOJI,
        isOwner: true,
        since: Date.now(),
    };
}

/** One row of the connected-users list, as clients render it. */
export interface BatonRosterEntry extends BatonPrincipal {
    /** True for the single user currently driving. */
    holdsControl: boolean;
}

/** The control view a specific principal gets (null = an unidentified client). */
export interface ControlView {
    /**
     * VIEW-ONLY for this client. Back-compat with the kill-switch contract every
     * existing client reads: an unidentified client sees the raw kill-switch (does
     * the desktop hold control), an identified one sees "someone else is driving".
     */
    locked: boolean;
    holder: string | null;
    holderEmoji: string | null;
    /** The recipient's own principal id, so a client can spot itself in the list. */
    you: string | null;
    participants: BatonRosterEntry[];
}

export function batonRoster(): BatonRosterEntry[] {
    return live.participants.map((p) => ({ ...p, holdsControl: holdsBaton(live, p.id) }));
}

/** Build the control view for one principal (null for an unidentified socket). */
export function controlViewFor(principalId: string | null): ControlView {
    const holder = live.holder;
    return {
        locked:
            principalId === null
                ? holder === DESKTOP_PRINCIPAL
                : holder !== null && holder !== principalId,
        holder,
        holderEmoji: holder ? (find(live, holder)?.emoji ?? null) : null,
        you: principalId,
        participants: batonRoster(),
    };
}

/** Push each client ITS OWN control view (who is driving differs per recipient). */
function pushControl(): void {
    mobileEmitEach('control:changed', (principalId) => controlViewFor(principalId));
}

/** The live state (read-only) — for tests and the host status surface. */
export function batonState(): BatonState {
    return live;
}

/** The current holder's principal id, or null when the baton is free. */
export function batonHolder(): string | null {
    return live.holder;
}

/** A principal connected: add them to the roster (identity refreshed on reconnect). */
export function joinControl(principal: BatonPrincipal): void {
    const d = decideBaton(live, { kind: 'join', principal });
    live = d.state;
    if (d.changed) pushControl();
}

/** A principal disconnected: drop them, freeing the baton if they held it. */
export function leaveControl(id: string): void {
    const d = decideBaton(live, { kind: 'leave', id });
    live = d.state;
    if (d.changed) pushControl();
}

/**
 * Apply a control transfer (take / give / release), auditing the outcome.
 * Returns the decision so the caller can answer 403 with `reason`.
 */
export function requestControl(
    req: Extract<BatonRequest, { kind: 'take' | 'give' | 'release' }>,
): BatonDecision {
    const actorId = req.kind === 'give' ? req.from : req.by;
    const actor = find(live, actorId);
    const d = decideBaton(live, req);
    live = d.state;
    audit(
        `control.${req.kind}${d.allowed ? '' : '.refused'}`,
        req.kind === 'give' ? `→ ${find(live, req.to)?.name ?? req.to}` : (d.reason ?? undefined),
        actor ? { id: actor.id, emoji: actor.emoji, name: actor.name } : actorId,
    );
    if (d.changed) pushControl();
    return d;
}

/**
 * THE gate for every state-changing remote path: may this principal drive right
 * now? Upserts them into the roster (so a driver is always a known participant)
 * and claims the baton when it is free — which is what keeps a single connected
 * user working exactly as before, with no handshake.
 */
export function authorizeDrive(principal: BatonPrincipal): BatonDecision {
    const joined = decideBaton(live, { kind: 'join', principal });
    const d = decideBaton(joined.state, { kind: 'drive', by: principal.id });
    const changed = d.state !== live;
    live = d.state;
    if (changed) pushControl();
    return d;
}

// --- kill-switch compatibility ---------------------------------------------

/**
 * True when the DESKTOP holds the baton — the original kill-switch predicate.
 * Every client that only understands "locked" keeps working: the desktop taking
 * control still freezes every remote.
 */
export function isLocked(): boolean {
    return live.holder === DESKTOP_PRINCIPAL;
}

/**
 * Engage / release the kill-switch = the desktop TAKING or RELEASING the baton.
 * As an owner the desktop can always take it, whoever is driving. Audited, and
 * pushed to every live client so a handoff propagates immediately.
 */
export function setLocked(value: boolean): void {
    if (isLocked() === value) return;
    if (value) {
        live = decideBaton(live, { kind: 'join', principal: desktopPrincipal() }).state;
        const d = decideBaton(live, { kind: 'take', by: DESKTOP_PRINCIPAL });
        live = d.state;
        audit('lock.engage', undefined, DESKTOP_PRINCIPAL);
    } else {
        const d = decideBaton(live, { kind: 'release', by: DESKTOP_PRINCIPAL });
        live = d.state;
        audit('lock.release', undefined, DESKTOP_PRINCIPAL);
    }
    pushControl();
}

/** Reset module state (test-only). */
export function _resetBatonForTest(): void {
    live = emptyBaton();
}
