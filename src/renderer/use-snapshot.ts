import { startTransition, useEffect, useRef, useState } from 'react';
import { share } from '../core/share.js';
import { EMPTY_SNAPSHOT, type GenieBridge, type GenieSnapshot } from './bridge.js';

/**
 * A PUSHED UPDATE GIVES WAY TO THE PERSON (genie#1340). Main pushes the estate up to twenty times a second while any agent
 * works, and the watched agent's detail as often. Rendered at React's default priority, each push is drawn in one
 * uninterrupted task, and a keystroke that arrives meanwhile waits for all of it — measured on omarchy-test with eleven
 * agents streaming, keystroke → paint was 140 ms–1 s at p95. As a TRANSITION the render yields to input every few
 * milliseconds: the keystroke is committed first, and the push is drawn after it (or folded into the next one).
 */
export function pushed(update: () => void): void {
    startTransition(update);
}

/**
 * ONE PUSH IN FLIGHT (Tynn #665). A transition that has not committed keeps its update queued, and the update keeps what
 * its updater closes over. Handing React every push (`setSnapshot((prev) => share(prev, s))`) queued one whole structured
 * clone of the estate per push for as long as the window was slow to draw — an owner-scale page, input coming first —
 * and re-ran `share` over every one of them on each render attempt: the renderer reached 4 GB in minutes and died
 * (#664's soak). Here a push is shared on ARRIVAL against the newest estate, outside React, and the clone is dropped; at
 * most one update is ever queued, and it reads the newest estate when React draws it. After a commit, an estate that moved
 * meanwhile is scheduled once more. A push equal to the newest is not handed to React at all.
 */
export class PushedState<T> {
    #latest: T;
    #shown: T;
    #inFlight = false;
    readonly #schedule: (read: () => T, urgent: boolean) => void;

    constructor(initial: T, schedule: (read: () => T, urgent: boolean) => void) {
        this.#latest = initial;
        this.#shown = initial;
        this.#schedule = schedule;
    }

    get latest(): T { return this.#latest; }

    /** A new value; `urgent` draws it at React's default priority (a first read), not as a transition. */
    offer(next: T, urgent = false): void {
        if (Object.is(next, this.#latest)) return;
        this.#latest = next;
        if (this.#inFlight) return;
        this.#inFlight = true;
        this.#schedule(this.#read, urgent);
    }

    /** What React committed: the update in flight landed; an estate newer than it is scheduled once. */
    committed(value: T): void {
        this.#shown = value;
        this.#inFlight = false;
        if (!Object.is(this.#latest, this.#shown)) {
            this.#inFlight = true;
            this.#schedule(this.#read, false);
        }
    }

    readonly #read = (): T => this.#latest;
}

/** The estate, read once and then kept current by main's pushes. */
export function useSnapshot(bridge: Pick<GenieBridge, 'snapshot' | 'subscribe'> | undefined): GenieSnapshot {
    const [snapshot, setSnapshot] = useState<GenieSnapshot>(EMPTY_SNAPSHOT);
    const state = useRef<PushedState<GenieSnapshot> | null>(null);
    const shown = useRef(snapshot);
    shown.current = snapshot;

    // Each commit tells the store what landed, so the next push (or one that arrived meanwhile) is scheduled.
    useEffect(() => { state.current?.committed(snapshot); }, [snapshot]);

    useEffect(() => {
        if (!bridge) return;
        let live = true;
        let pushedYet = false;
        const store = new PushedState<GenieSnapshot>(shown.current, (read, urgent) => {
            if (!live) return;
            if (urgent) setSnapshot(read); else pushed(() => setSnapshot(read));
        });
        state.current = store;

        // One read to start from, then PUSH. No interval anywhere: a polled dashboard is wrong
        // for up to its interval, and with thirty agents it re-reads the registry a hundred
        // times a minute to learn nothing.
        // Each push arrives as a new object graph (a structured clone): what did not change keeps its identity
        // (core/share.ts), so a view keyed on an agent's row or a workspace draws only when that changed. A push is the whole
        // estate, so a first read that answers after one is older than it, and dropped.
        // A closed link keeps the last estate (or honest loading); the next push can still recover it (#636).
        try {
            void bridge.snapshot().then((s) => { if (live && !pushedYet) store.offer(share(store.latest, s), true); }).catch(() => {});
        } catch { /* The bridge can refuse before returning a promise; keep the push subscription below. */ }
        const off = bridge.subscribe((s) => { if (!live) return; pushedYet = true; store.offer(share(store.latest, s)); });

        return () => { live = false; off(); if (state.current === store) state.current = null; };
    }, [bridge]);

    return snapshot;
}
