import type { AskWindowGeometry } from './question-drawer.js';

/** Tynn #1019: not built yet (RED). */
export function askWindowMaximized(_workArea: AskWindowGeometry): AskWindowGeometry {
    throw new Error('not built');
}

export function askWindowRestored(_input: { saved: AskWindowGeometry; workArea: AskWindowGeometry; drawerOpen: boolean; drawerOpenWhenSaved: boolean; baseWidth: number | null }): { bounds: AskWindowGeometry; baseWidth: number | null } {
    throw new Error('not built');
}
