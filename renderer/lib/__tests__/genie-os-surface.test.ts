import { describe, expect, it } from 'vitest';
import {
    isGenieOsTerminalSpec,
    sidebarWorkspaceRows,
    workspaceSurfaceRows,
    workspaceSurfaceSpecs,
} from '../genie';

describe('Genie OSA surface isolation', () => {
    const osSpec = {
        id: 'legacy-osa',
        type: 'terminal',
        meta: { agent_id: 'genie:workstation' },
    } as never;
    const ordinary = {
        id: 'ordinary',
        type: 'terminal',
        meta: { agent_id: 'workspace:genie' },
    } as never;

    it('recognizes the immutable identity instead of guessing from its label or workspace', () => {
        expect(isGenieOsTerminalSpec(osSpec)).toBe(true);
        expect(isGenieOsTerminalSpec(ordinary)).toBe(false);
    });

    it('never exposes the Genie OSA terminal in workspace sidebar or Floor collections', () => {
        expect(workspaceSurfaceSpecs([osSpec, ordinary])).toEqual([ordinary]);
    });

    it('hides a legacy registered workspace that points at the managed OSA directory', () => {
        const osRow = { id: 'old-os-row', path: 'C:\\Genie\\genie-os.agi' };
        const project = { id: 'project', path: 'C:\\Projects\\real.agi' };
        expect(workspaceSurfaceRows([osRow, project], 'C:\\Genie\\genie-os.agi')).toEqual([project]);
    });
});

/**
 * The sidebar's System Workspace chip reveals a SYNTHETIC row — it is never in
 * `workspaces` and never in the DB, so the sidebar list has to compose it in.
 *
 * Two rules have to hold at once, and they pull in opposite directions:
 * a LEGACY registered row pointing at the managed OSA directory stays hidden
 * (that is what `workspaceSurfaceRows` is for), while the synthetic row appears
 * on top when revealed. Composing them in the wrong order puts the managed
 * directory back on screen under a different id.
 */
describe('sidebarWorkspaceRows', () => {
    const project = { id: 'project', path: 'C:\Projects\real.agi' };
    const legacyOs = { id: 'old-os-row', path: 'C:\Genie\genie-os.agi' };
    const synthetic = { id: 'genie-system', path: 'C:\Genie\genie-os.agi' };
    const osPath = 'C:\Genie\genie-os.agi';

    it('leaves the list alone while the System Workspace is hidden', () => {
        expect(sidebarWorkspaceRows([project], null, false, osPath)).toEqual([project]);
    });

    it('pins the revealed System Workspace to the top', () => {
        expect(sidebarWorkspaceRows([project], synthetic, true, osPath)).toEqual([
            synthetic,
            project,
        ]);
    });

    it('still hides the legacy registered row when the synthetic one is revealed', () => {
        // Both point at the managed directory. Revealing the chip must not
        // smuggle the legacy row back in beside its synthetic replacement.
        expect(sidebarWorkspaceRows([legacyOs, project], synthetic, true, osPath)).toEqual([
            synthetic,
            project,
        ]);
    });

    it('reveals nothing when there is no System Workspace to reveal', () => {
        // A remote window drives ANOTHER machine, so it has no synthetic row —
        // the chip must not be able to conjure an empty one.
        expect(sidebarWorkspaceRows([project], null, true, osPath)).toEqual([project]);
    });
});
