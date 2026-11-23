import { EMPTY_FRONT_DOOR_WATCH, type FrontDoorWatchView } from '../core/front-door-watch.js';

/**
 * MAIN'S FRONT DOOR, AS GENIE-HOST SAYS IT (Tynn #1046, 2g-4d-D1): one view, kept from main's own client's
 * `frontdoor.watch`. No front door (port 0, no CA) until genie-host has said it; `ready` waits for that, no longer than its
 * deadline, so the browser sessions and the site panels are made with the real one. A change says whether the port or the
 * CA moved (every browser session is routed again) or only the routes and sites did (the browser's facts are said again).
 */
export interface WindowFrontDoor {
    start(): void;
    ready(deadlineMs: number): Promise<void>;
    now(): FrontDoorWatchView;
    onChange(listener: (view: FrontDoorWatchView, moved: boolean) => void): () => void;
}

export function windowFrontDoor(own: { watchFrontDoor(onView: (view: FrontDoorWatchView) => void): () => void }): WindowFrontDoor {
    let view: FrontDoorWatchView = EMPTY_FRONT_DOOR_WATCH;
    let started = false;
    let said = false;
    const waiting = new Set<() => void>();
    const listeners = new Set<(view: FrontDoorWatchView, moved: boolean) => void>();
    const heard = (next: FrontDoorWatchView): void => {
        const moved = next.port !== view.port || next.caPem !== view.caPem;
        view = next;
        if (!said) { said = true; for (const w of [...waiting]) w(); waiting.clear(); }
        for (const l of [...listeners]) l(next, moved);
    };
    return {
        start: () => { if (started) return; started = true; own.watchFrontDoor(heard); },
        ready: (deadlineMs) => (said ? Promise.resolve() : new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); waiting.delete(done); resolve(); };
            const timer = setTimeout(done, deadlineMs);
            waiting.add(done);
        })),
        now: () => view,
        onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
