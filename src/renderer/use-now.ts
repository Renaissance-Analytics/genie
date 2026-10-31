import { useEffect, useState } from 'react';

/**
 * The time, re-read every `everyMs` while `active` — for a countdown on screen ("1:42 left"). `fixed` (tests, a static
 * render) pins it and starts no timer.
 */
export function useNow(active: boolean, fixed?: number, everyMs = 1000): number {
    const [now, setNow] = useState(() => fixed ?? Date.now());
    useEffect(() => {
        if (!active || fixed !== undefined) return;
        setNow(Date.now());
        const t = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(t);
    }, [active, fixed, everyMs]);
    return fixed ?? now;
}
