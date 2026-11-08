import { useEffect, useState } from 'react';
import type { GenieBridge } from './bridge.js';
import type { PickHostPath } from './components/HostPathPicker.js';

/**
 * A picker asked without a start (an alert's sound, an empty Primary workspace) opens at `start`, the window's own
 * pickerStart for the host it drives.
 */
export function withPickerStart(opts: Parameters<PickHostPath>[0], _start: string): Parameters<PickHostPath>[0] {
    return opts;
}

/**
 * THE HOST'S HOME FOLDER, for a picker's last-resort start (core/add-workspace.ts `pickerStart`): asked of the bridge
 * this window drives. `null` until it answers, or when it cannot.
 */
export function useHostHome(bridge: GenieBridge | undefined): string | null {
    const [home, setHome] = useState<string | null>(null);
    useEffect(() => { void bridge?.host?.home?.().then(setHome, () => {}); }, [bridge]);
    return home;
}
