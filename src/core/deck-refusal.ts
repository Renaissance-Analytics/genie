import type { FeatureAction } from '../renderer/features.js';

/**
 * A REFUSED DECK ACTION, AS THE LIFECYCLE LOG SAYS IT (Tynn #600): which action, on which item, and why, on one line. The
 * owner dismissed and answered questions that stayed, and nothing anywhere said why; now every refusal leaves this.
 */
export function deckRefusalLine(action: FeatureAction, error: unknown): string {
    const a = action as { kind: string; item?: { id?: unknown }; ids?: unknown; olderThanMs?: unknown };
    const item = typeof a.item?.id === 'string' ? a.item.id
        : Array.isArray(a.ids) ? a.ids.filter((id): id is string => typeof id === 'string').join(',')
        : typeof a.olderThanMs === 'number' ? `older-than-${a.olderThanMs}ms`
        : '-';
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*\r?\n\s*/g, ' ').trim();
    return `deck action refused kind=${a.kind} item=${item} reason=${reason}`;
}
