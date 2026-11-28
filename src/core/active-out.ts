import { shortDateTime } from './clock-words.js';
import type { Headroom } from './headroom.js';

/**
 * WHEN THE ACTIVE ACCOUNT RUNS OUT (Tynn #1089; the owner, 2026-11-27: his coordinator sat held on a spent week while other
 * accounts had room). The person sets the rule — a framework, not a policy:
 * - `ask` (the default): where the held agent is, and on the Accounts chip, "<active> is out until <reset> · <other> has
 *   room." with one click, "Switch to <other>" — the normal switch;
 * - `switch`: Genie switches the active account through that same normal switch, once per reset, and says so.
 * With no other account with room it says so plainly, with the reset; what the person sends waits and goes then.
 *
 * WHETHER AN ACCOUNT HAS ROOM IS ONE FUNCTION (`accountRoom`). Today it is fed the account's own last reading (the headroom
 * board); a turn-free read (Tynn #1091, prism-acp `readRateLimits`) can feed it later without changing anything that decides.
 */

export const ACTIVE_OUT_SETTING = 'when_active_account_out';
export type ActiveOutChoice = 'ask' | 'switch';

export type AccountRoom =
    | { readonly state: 'room'; readonly leftPct: number }
    | { readonly state: 'spent'; readonly resetsAtMs: number | null }
    | { readonly state: 'unknown' };

/**
 * An account's room, from its own reading: its TIGHTEST window decides (98 % of the 5 h left is nothing with the week spent).
 * No reading, or a spent window already past its reset, is `unknown`: never guessed as room.
 */
export function accountRoom(reading: Headroom | null | undefined, nowMs: number, refusedUntil: number | null = null): AccountRoom {
    // THE PROVIDER'S OWN REFUSAL (the limit gate: a rejected window, until its reset) decides first: a login it refuses is
    // spent, whatever its last reading said (a read of its usage can lag the refusal).
    if (refusedUntil !== null && refusedUntil > nowMs) return { state: 'spent', resetsAtMs: refusedUntil };
    if (!reading) return { state: 'unknown' };
    const windows = reading.windows.length > 0 ? reading.windows : [{ window: reading.window, leftPct: reading.leftPct, resetsAtMs: reading.resetsAtMs, over: reading.over, usedPct: 100 - reading.leftPct }];
    const spent = windows.filter((w) => w.leftPct <= 0 || w.over);
    if (spent.length > 0) {
        const live = spent.filter((w) => w.resetsAtMs > nowMs);
        if (live.length === 0) return { state: 'unknown' };
        return { state: 'spent', resetsAtMs: Math.max(...live.map((w) => w.resetsAtMs)) };
    }
    return { state: 'room', leftPct: Math.min(...windows.map((w) => w.leftPct)) };
}

interface Named { readonly id: string; readonly label: string }

export type ActiveOut =
    | { readonly kind: 'fine' }
    | { readonly kind: 'ask' | 'switch'; readonly active: Named; readonly resetsAtMs: number | null; readonly other: Named & { readonly leftPct: number } }
    | { readonly kind: 'no-room'; readonly active: Named; readonly resetsAtMs: number | null };

export interface ActiveOutInput {
    readonly provider: string;
    readonly activeId: string;
    readonly known: readonly { readonly id: string; readonly provider: string; readonly label: string }[];
    readonly choice: ActiveOutChoice;
    readonly room: (accountId: string) => AccountRoom;
}

/** What the setting does now: nothing while the active account has room; else the other account with the MOST room. */
export function whenActiveOut(input: ActiveOutInput): ActiveOut {
    const activeRoom = input.room(input.activeId);
    if (activeRoom.state !== 'spent') return { kind: 'fine' };
    const mine = input.known.filter((a) => a.provider === input.provider);
    const activeRecord = mine.find((a) => a.id === input.activeId);
    const active = { id: input.activeId, label: activeRecord?.label ?? input.activeId };
    let best: (Named & { leftPct: number }) | null = null;
    for (const a of mine) {
        if (a.id === input.activeId) continue;
        const r = input.room(a.id);
        if (r.state === 'room' && r.leftPct > 0 && (best === null || r.leftPct > best.leftPct)) best = { id: a.id, label: a.label, leftPct: r.leftPct };
    }
    if (best === null) return { kind: 'no-room', active, resetsAtMs: activeRoom.resetsAtMs };
    return { kind: input.choice, active, resetsAtMs: activeRoom.resetsAtMs, other: best };
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex' };

/** The line, the reset said plainly. `''` when nothing is out. */
export function activeOutWords(out: ActiveOut, provider = 'claude'): string {
    if (out.kind === 'fine') return '';
    const until = out.resetsAtMs === null ? 'its reset' : shortDateTime(out.resetsAtMs);
    if (out.kind === 'no-room') return `No ${PROVIDER_NAMES[provider] ?? provider} account has room: ${out.active.label} is out until ${until}. What you send waits and goes then.`;
    if (out.kind === 'ask') return `${out.active.label} is out until ${until} · ${out.other.label} has room.`;
    return `${out.active.label} is out until ${until}, so Genie switched to ${out.other.label}, which has room (your setting: When the active account runs out).`;
}

/** What the chat line and the Accounts chip are given: the words, and the account `Switch to` names (Ask me only). */
export interface ActiveOutView {
    readonly words: string;
    readonly switchTo?: { readonly id: string; readonly label: string };
}

export function activeOutView(out: ActiveOut, provider = 'claude'): ActiveOutView | null {
    if (out.kind === 'fine') return null;
    return { words: activeOutWords(out, provider), ...(out.kind === 'ask' ? { switchTo: { id: out.other.id, label: out.other.label } } : {}) };
}

export interface ActiveOutPorts {
    readonly providers: () => readonly string[];
    readonly known: () => ActiveOutInput['known'];
    readonly activeId: (provider: string) => string;
    readonly room: (accountId: string) => AccountRoom;
    readonly choice: () => ActiveOutChoice;
    /** Whether any agent is held on the limit on this provider's ACTIVE account: a spent account nobody waits on is left alone. */
    readonly heldOnActive: (provider: string) => boolean;
    /** The normal switch (`accounts.act` switch): the person's own, done for them only under `switch`. */
    readonly switchTo: (accountId: string) => Promise<{ ok: boolean; reason?: string }>;
    /** What the held agents and the Accounts chip show now; `null` = nothing. */
    readonly tell: (provider: string, out: ActiveOut | null) => void;
}

/**
 * The setting, acted on. `check()` after a reading or a hold changes. Under `switch` the switch is made ONCE per active
 * account and reset (a switch that is refused is said, never retried in a loop); under `ask` it is only said.
 */
export class ActiveOutService {
    readonly #ports: ActiveOutPorts;
    readonly #switched = new Set<string>();
    readonly #told = new Map<string, string>();

    constructor(ports: ActiveOutPorts) { this.#ports = ports; }

    async check(): Promise<void> {
        for (const provider of this.#ports.providers()) {
            const out = this.#ports.heldOnActive(provider)
                ? whenActiveOut({ provider, activeId: this.#ports.activeId(provider), known: this.#ports.known(), choice: this.#ports.choice(), room: this.#ports.room })
                : { kind: 'fine' as const };
            if (out.kind === 'switch') {
                const key = `${provider}\u0000${out.active.id}\u0000${out.resetsAtMs ?? ''}`;
                if (this.#switched.has(key)) continue;
                this.#switched.add(key);
                this.#say(provider, out);
                const result = await this.#ports.switchTo(out.other.id);
                // Refused (a sign-in it needs, the account gone): the person is asked instead, with the reason.
                if (!result.ok) this.#say(provider, { ...out, kind: 'ask' });
                continue;
            }
            this.#say(provider, out.kind === 'fine' ? null : out);
        }
    }

    #say(provider: string, out: ActiveOut | null): void {
        // WHAT IS SAID, not the figures under it: another account's share moves with every reading, and each change would
        // say the line again in every held agent's stream.
        const key = out === null || out.kind === 'fine' ? '' : `${out.kind}|${out.active.id}|${'other' in out ? out.other.id : ''}|${out.resetsAtMs ?? ''}`;
        if ((this.#told.get(provider) ?? '') === key) return;
        this.#told.set(provider, key);
        this.#ports.tell(provider, out);
    }
}
