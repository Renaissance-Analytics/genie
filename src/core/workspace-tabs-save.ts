import type { Exclusion } from './workspace-elements.js';
import type { TabsState, WorkspaceTab } from './workspace-tabs.js';

/** Inert stubs (RED): the tabs saved to `.genie/tabs.json` (Tynn #756, PR7). The implementation lands after the tests are seen failing. */

export const TABS_SCHEMA_URL = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/tabs.schema.json';

export function tabsDeclaration(_input: { tabs: string; panelSplits: string; panelLayout: string }, _workspacePath: string): { files: { path: string; value: unknown }[]; excluded: Exclusion[] } {
    return { files: [], excluded: [] };
}

export function tabsRestore(_file: unknown, _ctx: { workspacePath: string; siteHosts: readonly string[] }): { state: TabsState; panelSplits: string | null; panelLayout: string | null; notes: string[] } {
    return { state: { tabs: [] }, panelSplits: null, panelLayout: null, notes: [] };
}

export function tabsRestorePlan(_file: TabsState, _existing: TabsState): { add: WorkspaceTab[]; present: string[]; differs: string[]; state: TabsState } {
    return { add: [], present: [], differs: [], state: { tabs: [] } };
}
