import { useEffect, useRef, useState } from 'react';
import { api } from './genie';

/**
 * Which terminals are RECEIVING BYTES right now.
 *
 * Deliberately not `activeIds`, and the difference is the whole point of this
 * file. `activeIds` is "this spec has a live pty" — a panel joins it when XTerm
 * mounts and leaves on exit — so for any surface that is open, it is true the
 * entire time it is open. Using it to drive an activity animation makes the
 * animation mean "you opened this", which is something the user can already see.
 *
 * This is the other question: has output arrived in the last {@link DECAY_MS}?
 *
 * Reuses the `terminal:data` push that `Terminal.tsx` already consumes to feed
 * its own xterm — no extra IPC and no polling. An id is added on its first byte
 * and removed {@link DECAY_MS} after its last; a fresh byte resets the timer, so
 * a continuously-working agent stays in the set without flickering.
 *
 * Extracted from `Chooser` (where it drove the terminal dots) so the Genie OS
 * surfaces can ask the same question of the same source. One implementation, or
 * the two drift and "active" comes to mean different things one panel apart.
 */

/** How long after its last byte a terminal still counts as streaming. Long
 *  enough to bridge the gaps between an agent's writes, short enough that a
 *  finished turn stops reading as work in progress. */
export const DECAY_MS = 1200;

export function useStreamingTerminals(): Set<string> {
    const [streaming, setStreaming] = useState<Set<string>>(() => new Set());
    const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    useEffect(() => {
        const live = timers.current;
        const off = api().on.terminalData(({ id }) => {
            setStreaming((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
            const existing = live.get(id);
            if (existing) clearTimeout(existing);
            live.set(
                id,
                setTimeout(() => {
                    live.delete(id);
                    setStreaming((prev) => {
                        if (!prev.has(id)) return prev;
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                }, DECAY_MS),
            );
        });
        return () => {
            off();
            for (const t of live.values()) clearTimeout(t);
            live.clear();
        };
    }, []);

    return streaming;
}
