import { useEffect, useState } from 'react';
import type { GenieBridge } from './bridge.js';

/**
 * THE HOST'S HOME FOLDER, for a picker's last-resort start (core/add-workspace.ts `pickerStart`): asked of the bridge
 * this window drives. `null` until it answers, or when it cannot.
 */
export function useHostHome(bridge: GenieBridge | undefined): string | null {
    const [home, setHome] = useState<string | null>(null);
    useEffect(() => { void bridge?.host?.home?.().then(setHome, () => {}); }, [bridge]);
    return home;
}
