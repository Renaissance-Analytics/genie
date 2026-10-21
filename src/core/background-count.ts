import { agentShells } from './agent-shells.js';
import type { StreamEvent } from './stream-event.js';
import type { TimedEvent } from './stream-view.js';

/**
 * WHAT AN AGENT STILL HAS RUNNING IN THE BACKGROUND, KEPT (the owner, 2026-10-21: an agent doing work "shows as idle").
 * Its turn has ended, but the background shells and tasks it started are running — the Shells tab's count
 * (core/agent-shells.ts: running, not Claude Code's own). That count reads the whole ledger, so it is KEPT and read
 * again only when a row that can change it arrives: a task notice (one task's event, or the full live set) or a new
 * provider process (`run`, which leaves nothing running). Any other row — every tool call, every chunk — costs nothing.
 */
export function touchesBackground(e: StreamEvent): boolean {
    return e.kind === 'run' || (e.kind === 'notice' && (e.task !== undefined || e.tasks !== undefined));
}

export class BackgroundCount {
    #stale = true;
    #count = 0;
    #scans = 0;

    /** A row arrived or was replaced: its event (and, for a replacement, the one it held). */
    changed(e: StreamEvent): void {
        if (touchesBackground(e)) this.#stale = true;
    }

    /** The count, read again from `rows` only if something that can change it arrived. */
    count(rows: readonly TimedEvent[]): number {
        if (this.#stale) {
            this.#count = agentShells(rows).count;
            this.#stale = false;
            this.#scans += 1;
        }
        return this.#count;
    }

    /** How many times the ledger was read (the test's count). */
    get scans(): number {
        return this.#scans;
    }
}
