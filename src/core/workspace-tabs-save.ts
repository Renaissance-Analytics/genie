import { SHARED_SCHEMAS_PIN } from './shared-schemas-pin.js';
import { folderWithin } from './v1-processes.js';
import type { Exclusion } from './workspace-elements.js';
import { cwdProblem } from './workspace-save-guard.js';
import { parseTabs, type Panel, type TabsState, type WorkspaceTab } from './workspace-tabs.js';

/**
 * THE WORKSPACE'S TABS, SAVED AS `.genie/tabs.json` (Tynn #756, PR7): the tabs a person designed (their grids and panels), where
 * the splits sit and how the terminals are laid out, in the shape shared-schemas v0.5.0 publishes (`tabs.schema.json`). It is a
 * UI preference rather than automation, so one file, and the order of the tabs is kept.
 *
 * What is live on this machine is not saved: a `terminal` panel is a terminal id (an empty cell), and a `files` panel's folder is
 * relative to the workspace or not saved (the same `cwd` rule the guard applies, `cwdProblem`). On a clone, what it can show it restores; a `site` panel whose site is not there yet
 * is an empty cell, said. Nothing a clone already has is overwritten.
 */

export const TABS_SCHEMA_URL = `https://raw.githubusercontent.com/${SHARED_SCHEMAS_PIN.repo}/${SHARED_SCHEMAS_PIN.tag}/schemas/workspace/tabs.schema.json`;

const FILE = '.genie/tabs.json';
const LAYOUT_MODES: readonly string[] = ['single', 'columns', 'rows', 'grid'];
const MIN_FRACTION = 0.1;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/** A stored axis is kept only when it fits: at least two panes, each at least a tenth, the sum one (core/panel-layout.ts). */
function fraction(raw: unknown): number[] | null {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    if (!raw.every((f) => typeof f === 'number' && Number.isFinite(f) && f >= MIN_FRACTION - 1e-9)) return null;
    return Math.abs((raw as number[]).reduce((a, b) => a + b, 0) - 1) < 1e-6 ? [...(raw as number[])] : null;
}

function storedSplits(raw: string): Record<string, unknown> {
    if (raw.trim() === '') return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** The tabs, the splits and the terminal layout as the settings keep them, as the schema's `.genie/tabs.json` (no file when nothing is designed or remembered). */
export function tabsDeclaration(input: { tabs: string; panelSplits: string; panelLayout: string }, workspacePath: string): { files: { path: string; value: unknown }[]; excluded: Exclusion[] } {
    const excluded: Exclusion[] = [];
    const tabs = parseTabs(input.tabs).tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        layout: tab.layout,
        cells: tab.cells.map((cell, i): Panel | null => {
            if (cell === null) return null;
            const field = `${FILE}#${tab.id}/cell-${i + 1}`;
            if (cell.kind === 'terminal') {
                excluded.push({ field, reason: 'a terminal is a live session on this machine, so it is saved as an empty cell' });
                return null;
            }
            if (cell.kind === 'files' && cell.ref !== null) {
                let ref = cell.ref;
                if (ABSOLUTE.test(ref)) {
                    const inside = folderWithin(workspacePath, ref);
                    if (inside === null) {
                        excluded.push({ field, reason: 'its folder is outside the workspace, which a clone would not have, so it is saved as an empty cell' });
                        return null;
                    }
                    ref = inside === '' ? '.' : inside;
                }
                const problem = cwdProblem(ref);
                if (problem !== null) {
                    excluded.push({ field, reason: `its folder ${problem}, so it is saved as an empty cell` });
                    return null;
                }
                return { kind: 'files', ref };
            }
            return { kind: cell.kind, ref: cell.ref };
        }),
    }));
    const stored = storedSplits(input.panelSplits);
    const grid = isRecord(stored.grid) ? stored.grid : {};
    const splits: Record<string, number[]> = {};
    for (const [key, raw] of [['columns', stored.columns], ['rows', stored.rows], ['grid.columns', grid.columns], ['grid.rows', grid.rows]] as const) {
        const f = fraction(raw);
        if (f !== null) splits[key] = f;
    }
    const layout = LAYOUT_MODES.includes(input.panelLayout) ? input.panelLayout : null;
    if (tabs.length === 0 && Object.keys(splits).length === 0 && layout === null) return { files: [], excluded };
    return {
        files: [{ path: FILE, value: { $schema: TABS_SCHEMA_URL, tabs, ...(Object.keys(splits).length > 0 ? { panelSplits: splits } : {}), ...(layout !== null ? { panelLayout: layout } : {}) } }],
        excluded,
    };
}

/**
 * What a clone makes of a `.genie/tabs.json`: the tabs (a malformed one dropped), the splits and layout as the settings keep them
 * (a value that does not fit is not used), and a note for everything left out. A terminal panel, a folder outside the workspace
 * and a site that is not in this workspace are each an empty cell, so a hand-edited file cannot point a panel at the machine.
 */
export function tabsRestore(file: unknown, ctx: { workspacePath: string; siteHosts: readonly string[] }): { state: TabsState; panelSplits: string | null; panelLayout: string | null; notes: string[] } {
    const nothing = { state: { tabs: [] } as TabsState, panelSplits: null, panelLayout: null, notes: [] as string[] };
    if (!isRecord(file)) return nothing;
    const notes: string[] = [];
    const rawTabs = Array.isArray(file.tabs) ? file.tabs : [];
    const parsed = parseTabs(JSON.stringify({ tabs: rawTabs })).tabs;
    if (parsed.length < rawTabs.length) notes.push(`${rawTabs.length - parsed.length} tab${rawTabs.length - parsed.length === 1 ? '' : 's'} in the file could not be read (an unknown layout, or no name or id), so ${rawTabs.length - parsed.length === 1 ? 'it was' : 'they were'} left out`);
    const tabs: WorkspaceTab[] = parsed.map((tab) => ({
        ...tab,
        cells: tab.cells.map((cell, i): Panel | null => {
            if (cell === null) return null;
            const where = `${tab.name}, cell ${i + 1}`;
            if (cell.kind === 'terminal') { notes.push(`${where}: a terminal cannot come from a file, so it is empty`); return null; }
            if (cell.kind === 'files' && cell.ref !== null) {
                const problem = cwdProblem(cell.ref);
                if (problem !== null) { notes.push(`${where}: its folder ${problem}, so it is empty`); return null; }
            }
            if (cell.kind === 'site' && cell.ref !== null && !ctx.siteHosts.includes(cell.ref)) { notes.push(`${where}: the site ${cell.ref} is not in this workspace (yet), so it is empty`); return null; }
            return cell;
        }),
    }));
    let panelSplits: string | null = null;
    if (isRecord(file.panelSplits)) {
        const given = file.panelSplits;
        const columns = fraction(given.columns);
        const rows = fraction(given.rows);
        const gridColumns = fraction(given['grid.columns']);
        const gridRows = fraction(given['grid.rows']);
        for (const key of ['columns', 'rows', 'grid.columns', 'grid.rows']) {
            if (given[key] !== undefined && fraction(given[key]) === null) notes.push(`panelSplits.${key} does not fit (two or more panes, each at least a tenth, adding to one), so it is not used`);
        }
        const grid = gridColumns || gridRows ? { grid: { ...(gridColumns ? { columns: gridColumns } : {}), ...(gridRows ? { rows: gridRows } : {}) } } : {};
        const out = { ...(columns ? { columns } : {}), ...(rows ? { rows } : {}), ...grid };
        if (Object.keys(out).length > 0) panelSplits = JSON.stringify(out);
    }
    let panelLayout: string | null = null;
    if (file.panelLayout !== undefined) {
        if (typeof file.panelLayout === 'string' && LAYOUT_MODES.includes(file.panelLayout)) panelLayout = file.panelLayout;
        else notes.push(`panelLayout ${JSON.stringify(file.panelLayout)} is not one Genie has, so it is not used`);
    }
    return { state: { tabs }, panelSplits, panelLayout, notes };
}

/** Key order must not decide whether two tabs are the same. */
function canon(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
}

/** The tabs a clone gains from a file: the ones it lacks are added; one it has the same is present; one that differs is left as it is, and said. */
export function tabsRestorePlan(file: TabsState, existing: TabsState): { add: WorkspaceTab[]; present: string[]; differs: string[]; state: TabsState } {
    const add: WorkspaceTab[] = [];
    const present: string[] = [];
    const differs: string[] = [];
    for (const tab of file.tabs) {
        const here = existing.tabs.find((t) => t.id === tab.id);
        if (!here) add.push(tab);
        else (canon(here) === canon(tab) ? present : differs).push(tab.id);
    }
    return { add, present, differs, state: { tabs: [...existing.tabs, ...add] } };
}
