import { turnsOf } from './agent-index.js';
import type { LiveSession } from './roster.js';
import type { TimedEvent } from './stream-view.js';

/**
 * THE `turns` LAYOUT (the board's `&layout=turns`): the Stream folded into one card per turn. Title, a meta line
 * (`14:03 · 9 tools · 2 edits · 14k tok` — the time is the turn row's own, drawn by the component), the outcome
 * chips, and the rows inside. The latest turn is open on arrival, the others collapsed.
 *
 * Counted from the rows by the same walk the index column uses (`turnsOf`), so the two never disagree. The chips
 * are outcomes Genie can see: files edited inside the workspace (one chip when one file, `N files +a −b` when more)
 * and peers who spoke in the turn. Commits and answers are not on the wire as outcomes and are not drawn.
 *
 * `null` when the rows carry no turn markers — nothing is drawn as one long turn.
 */

export interface TurnChip {
    icon: 'file-code' | 'arrow-right-left';
    tone: 'ok' | 'violet';
    label: string;
}

export interface TurnCard {
    n: number;
    title: string;
    /** When the turn started (the marker row's time); `null` when the row carried none. */
    at: number | null;
    meta: string;
    chips: readonly TurnChip[];
    /** The rows inside the turn, in ledger order — without the marker itself. */
    rowIds: readonly string[];
    open: boolean;
    /** The marker row, a door (`?at=`). */
    rowId: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

export function turnCards(rows: readonly TimedEvent[], session: LiveSession | null, root: string | null): readonly TurnCard[] | null {
    const walked = turnsOf(rows, root);
    if (walked === null) return null;
    const { turns, deltas } = walked;
    const latest = turns.at(-1)!;

    let suffix = '';
    if (session) {
        if (session.pendingApproval) suffix = ' · parked';
        else if (session.turnState === 'failed') suffix = ' · ended';
        else if (session.turnState === 'working') suffix = ' · now';
    }

    return turns.map((t) => {
        const parts = [plural(t.tools, 'tool'), plural(t.edits, 'edit')];
        const delta = deltas.get(t) ?? null;
        if (delta !== null && delta > 0) parts.push(`${thousands(delta)} tok`);

        const chips: TurnChip[] = [];
        if (t.files.size > 0) {
            let plus = 0;
            let minus = 0;
            let counted = false;
            for (const f of t.files.values()) { plus += f.plus; minus += f.minus; counted = counted || f.counted; }
            const counts = counted ? [plus > 0 ? `+${plus}` : '', minus > 0 ? `−${minus}` : ''].filter(Boolean).join(' ') : '';
            const head = t.files.size === 1 ? [...t.files.keys()][0]! : `${t.files.size} files`;
            chips.push({ icon: 'file-code', tone: 'ok', label: counts ? `${head} ${counts}` : head });
        }
        for (const peer of t.peers) chips.push({ icon: 'arrow-right-left', tone: 'violet', label: `${peer} → you` });

        const isLatest = t === latest;
        return {
            n: t.n,
            title: `Turn ${t.n}${isLatest ? suffix : ''}`,
            at: t.at,
            meta: parts.join(' · '),
            chips,
            rowIds: [...t.rowIds].filter((id) => id !== t.rowId),
            open: isLatest,
            rowId: t.rowId,
        };
    });
}
