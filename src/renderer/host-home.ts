import { useEffect, useState } from 'react';
import type { GenieBridge } from './bridge.js';
import type { PickHostPath } from './components/HostPathPicker.js';

/**
 * A picker asked without a start (an alert's sound, an empty Primary workspace) opens at `start`, the window's own
 * pickerStart for the host it drives.
 */
export function withPickerStart(opts: Parameters<PickHostPath>[0], start: string): Parameters<PickHostPath>[0] {
    return opts.initialPath ? opts : { ...opts, initialPath: start };
}

/**
 * THE HOST'S HOME FOLDER, for a picker's last-resort start (core/add-workspace.ts `pickerStart`): asked of the bridge
 * this window drives. `null` until it answers, or when it cannot.
 */
export function useHostHome(bridge: GenieBridge | undefined): string | null {
    // KEYED BY BRIDGE (Tynn #527): the answer is kept with the bridge that gave it, so a window that switches to another
    // host never shows the previous host's home — not before the new one answers, not when it cannot, not when the old
    // answer lands late. A remote window once opened every picker at the CLIENT's home on a machine without that path.
    const [answer, setAnswer] = useState<{ bridge: GenieBridge; home: string } | null>(null);
    useEffect(() => {
        const host = bridge?.host;
        if (!bridge || !host?.home) return undefined;
        let live = true;
        void host.home().then((home) => { if (live) setAnswer({ bridge, home }); }, () => {});
        return () => { live = false; };
    }, [bridge]);
    return answer !== null && answer.bridge === bridge ? answer.home : null;
}
