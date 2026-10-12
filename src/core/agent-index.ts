import { confine } from './files-panel.js';
import type { LiveSession } from './roster.js';
import type { StreamEvent } from './stream-event.js';
import { editLineCounts, type TimedEvent } from './stream-view.js';

/**
 * THE INDEX COLUMN (the board's `Agent View`, 216px at the left of the Stream): **Turns** and **Files touched**.
 *
 * Every figure here is counted from the rows the surface already holds — tools and edits per turn, the context
 * delta the usage rows report inside a turn, an edit's line counts from its own before-and-after. Nothing is
 * estimated: a turn with no usage row has no `tok`, a Write with no old/new has no `+n`, a path outside the
 * workspace root is not listed (the files panel's rule — `rawInput` is untrusted).
 *
 * `null` when the rows carry no turn markers: a transcript Genie has no boundaries for (a replay from before the
 * marker existed, or a provider's own history) is not drawn as one long turn. Absence, not an empty column.
 */

export type IndexLive = 'ok' | 'warn' | 'bad';

export interface IndexItem {
    /** `turn:<n>`, `compacted:<rowId>`, `file:<path>`. */
    id: string;
    label: string;
    meta: string | null;
    /** The pulsing dot: the live turn's state. `null` on everything that is not happening now. */
    live: IndexLive | null;
    selected: boolean;
    mono: boolean;
    /** The row the item is a door to (`?at=`). */
    rowId: string;
}

export interface IndexSection {
    title: 'Turns' | 'Files touched';
    items: readonly IndexItem[];
}

interface Turn {
    n: number;
    rowId: string;
    rowIds: Set<string>;
    tools: number;
    edits: number;
    /** The last usage row's `used` inside the turn, or `null` when none was reported. */
    usedAtEnd: number | null;
    /** A compaction inside the turn makes the context delta meaningless. */
    compacted: boolean;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

function pathOf(event: Extract<StreamEvent, { kind: 'tool' }>, root: string): string | null {
    const input = event.rawInput;
    if (typeof input !== 'object' || input === null) return null;
    const raw = (input as { file_path?: unknown }).file_path;
    if (typeof raw !== 'string' || raw === '') return null;
    const confined = confine(root, raw);
    return confined === null || confined === '' ? null : confined;
}

export function agentIndex(rows: readonly TimedEvent[], session: LiveSession | null, root: string | null, selectedRowId: string | null): readonly IndexSection[] | null {
    if (!rows.some((r) => r.event.kind === 'turn')) return null;

    // Items are collected in ledger order — a turn, then the compaction that followed it — and reversed at the end.
    const ordered: Array<{ kind: 'turn'; turn: Turn } | { kind: 'compacted'; rowId: string; meta: string }> = [];
    let current: Turn | null = null;
    const files = new Map<string, { edits: number; plus: number; minus: number; counted: boolean; rowId: string }>();

    for (const row of rows) {
        const e = row.event;
        if (e.kind === 'turn') {
            current = { n: e.n, rowId: row.id, rowIds: new Set([row.id]), tools: 0, edits: 0, usedAtEnd: null, compacted: false };
            ordered.push({ kind: 'turn', turn: current });
            continue;
        }
        if (e.kind === 'divider') {
            const meta = e.before !== null && e.after !== null ? `${thousands(e.before)} → ${thousands(e.after)}` : 'context compacted';
            ordered.push({ kind: 'compacted', rowId: row.id, meta });
            if (current) { current.compacted = true; current.rowIds.add(row.id); }
            continue;
        }
        if (!current) continue; // rows before the first marker belong to no turn Genie can name
        current.rowIds.add(row.id);
        if (e.kind === 'usage') current.usedAtEnd = e.used;
        if (e.kind === 'tool') {
            if (e.toolKind === 'edit') {
                current.edits += 1;
                if (root !== null) {
                    const path = pathOf(e, root);
                    if (path !== null) {
                        const entry = files.get(path) ?? { edits: 0, plus: 0, minus: 0, counted: false, rowId: row.id };
                        entry.edits += 1;
                        entry.rowId = row.id;
                        const counts = editLineCounts(e.rawInput);
                        if (counts) { entry.plus += counts.plus; entry.minus += counts.minus; entry.counted = true; }
                        files.set(path, entry);
                    }
                }
            } else {
                current.tools += 1;
            }
        }
    }

    const turns = ordered.filter((o): o is { kind: 'turn'; turn: Turn } => o.kind === 'turn');
    const latest = turns.at(-1)!.turn;
    const selectedTurn = selectedRowId === null ? latest : (turns.find((o) => o.turn.rowIds.has(selectedRowId))?.turn ?? latest);

    // The live turn's state, from the session — and no claim without one.
    let suffix = '';
    let live: IndexLive | null = null;
    let ended = false;
    if (session) {
        if (session.pendingApproval) { suffix = ' · parked'; live = 'warn'; }
        else if (session.turnState === 'failed') { suffix = ' · ended'; live = 'bad'; ended = true; }
        else if (session.turnState === 'working') { suffix = ' · now'; live = 'ok'; }
    }

    // The session starts with nothing used; each turn's delta is measured from the last usage reported before it.
    let usedBeforeTurn = 0;
    const deltas = new Map<Turn, number | null>();
    for (const o of turns) {
        const t = o.turn;
        deltas.set(t, t.usedAtEnd !== null && !t.compacted ? t.usedAtEnd - usedBeforeTurn : null);
        usedBeforeTurn = t.usedAtEnd ?? usedBeforeTurn;
    }

    const turnItems: IndexItem[] = ordered.map((o) => {
        if (o.kind === 'compacted') return { id: `compacted:${o.rowId}`, label: '— compacted —', meta: o.meta, live: null, selected: false, mono: false, rowId: o.rowId };
        const t = o.turn;
        const isLatest = t === latest;
        const parts = [plural(t.tools, 'tool'), plural(t.edits, 'edit')];
        const delta = deltas.get(t) ?? null;
        if (delta !== null && delta > 0) parts.push(`${thousands(delta)} tok`);
        if (isLatest && ended) parts.unshift('no result');
        return {
            id: `turn:${t.n}`,
            label: `Turn ${t.n}${isLatest ? suffix : ''}`,
            meta: parts.join(' · '),
            live: isLatest ? live : null,
            selected: t === selectedTurn,
            mono: false,
            rowId: t.rowId,
        };
    }).reverse();

    const sections: IndexSection[] = [{ title: 'Turns', items: turnItems }];

    if (root !== null && files.size > 0) {
        const items: IndexItem[] = [...files.entries()]
            .sort((a, b) => b[1].rowId.localeCompare(a[1].rowId, 'en', { numeric: true }))
            .map(([path, f]) => {
                const parts = [plural(f.edits, 'edit')];
                if (f.counted) {
                    const counts: string[] = [];
                    if (f.plus > 0) counts.push(`+${f.plus}`);
                    if (f.minus > 0) counts.push(`−${f.minus}`);
                    if (counts.length > 0) parts.push(counts.join(' '));
                }
                return { id: `file:${path}`, label: path, meta: parts.join(' · '), live: null, selected: false, mono: true, rowId: f.rowId };
            });
        sections.push({ title: 'Files touched', items });
    }

    return sections;
}
