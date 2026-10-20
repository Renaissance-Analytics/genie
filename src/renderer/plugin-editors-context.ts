import { createContext, useContext } from 'react';
import type { ClaimingEditor } from '../core/plugin-editors.js';

/**
 * THE EDITORS OF THE PLUGINS ENABLED HERE (beta.33 item 14), from the feature snapshot the host pushes. Routing is CLIENT-
 * side (Genie 1 side.ts): the window you sit at decides which editor opens a file. Empty by default — a window that has
 * not heard from its host routes every file to the code editor, which is the fail-closed answer.
 */
export const PluginEditorsContext = createContext<readonly ClaimingEditor[]>([]);

export function usePluginEditors(): readonly ClaimingEditor[] {
    return useContext(PluginEditorsContext);
}
