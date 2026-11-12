import type { AlertKind } from './alerts.js';
import type { DeckItem } from './deck.js';

/**
 * WHICH ALERTS JUST HAPPENED (§6.3) — derived from two consecutive snapshots, never from a timer. A
 * Deck item that was not there before is an alert by its origin prefix (`q_` question, `appr_` /
 * `approval:` approval, `msg_` mail); an agent row that TURNED broken is a broken alert; an agent row
 * whose handoff is NEWER than before is a finish — a handoff is for agents and is no Deck item (Tynn
 * #658), so the person hears an agent finish and has nothing left to read or clear. What persists
 * alerts nobody twice; the first snapshot after boot alerts nobody at all, nor does an agent newly listed.
 */

export interface Alert {
    readonly kind: AlertKind;
    readonly workspace: string;
    readonly agent: string;
    readonly detail: string;
}

export interface AlertSnapshot {
    readonly deckItems: readonly DeckItem[] | null;
    readonly agents: readonly { id: string; name: string; workspaceId: string; state: string; reason: string | null; handoff?: { text: string; at: number } | null | undefined }[];
}

function kindOf(item: DeckItem): AlertKind | null {
    if (item.id.startsWith('q_')) return 'question';
    if (item.id.startsWith('appr_') || item.id.startsWith('approval:')) return 'approval';
    if (item.id.startsWith('msg_')) return 'mail';
    return null;
}

export function alertsBetween(prev: AlertSnapshot | null, next: AlertSnapshot): Alert[] {
    if (prev === null) return [];
    const alerts: Alert[] = [];
    const seen = new Set((prev.deckItems ?? []).map((i) => i.id));
    for (const item of next.deckItems ?? []) {
        if (seen.has(item.id)) continue;
        const kind = kindOf(item);
        if (!kind) continue;
        alerts.push({ kind, workspace: item.workspaceId ?? '—', agent: item.agentName ?? item.agentId ?? '—', detail: item.title });
    }
    const wasBroken = new Set(prev.agents.filter((a) => a.state === 'broken').map((a) => a.id));
    for (const a of next.agents) {
        if (a.state === 'broken' && !wasBroken.has(a.id)) alerts.push({ kind: 'broken', workspace: a.workspaceId, agent: a.name, detail: a.reason ?? 'broken' });
    }
    const handoffAt = new Map(prev.agents.map((a) => [a.id, a.handoff?.at ?? null]));
    for (const a of next.agents) {
        if (!a.handoff || !handoffAt.has(a.id)) continue;
        const before = handoffAt.get(a.id) ?? null;
        if (before === null || a.handoff.at > before) alerts.push({ kind: 'finished', workspace: a.workspaceId, agent: a.name, detail: `${a.name} finished: ${a.handoff.text}` });
    }
    return alerts;
}

/** STUB (tests first, Tynn #658): the finish alert's own high-water mark per agent. */
export function finishAlerts(seen: ReadonlyMap<string, number | null>, _agents: AlertSnapshot['agents']): { alerts: Alert[]; seen: ReadonlyMap<string, number | null> } {
    return { alerts: [], seen };
}
