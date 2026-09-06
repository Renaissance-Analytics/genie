import { describe, expect, it } from 'vitest';
import {
    isGenieOsTerminalSpec,
    makeSystemWorkspace,
    sidebarWorkspaceRows,
    systemWorkspaceRow,
    workspaceSurfaceRows,
    workspaceSurfaceSpecs,
    type WorkspaceRow,
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
        // A window with nothing to compose a row from — the chip must not be able
        // to conjure an empty one.
        expect(sidebarWorkspaceRows([project], null, true, osPath)).toEqual([project]);
    });
});

/**
 * WHICH row the sidebar chip reveals, and on which windows (genie#455).
 *
 * A remote window used to get no chip at all: the row is composed rather than
 * fetched, and composing it was refused outright to anything driving another
 * machine. So the Host Genie OSA was unreachable remotely even though its
 * terminal was sitting right there in the host's specs.
 *
 * The refusal was aimed at the wrong input. `operatorPath` is the OSA terminal's
 * cwd, and a remote window's specs are the HOST's — so it already names the
 * host's operator directory and composes correctly. `homeDir` is the local
 * fallback, and IT is the one that would name the wrong machine.
 */
describe('systemWorkspaceRow', () => {
    const HOST_GOSA = '/home/owner/.gosa';
    const LOCAL_HOME = 'C:\\Users\\someone-else';

    it('composes the host\u2019s row in a remote window, from the host\u2019s OSA cwd', () => {
        expect(systemWorkspaceRow(HOST_GOSA, LOCAL_HOME, true)).toEqual(
            makeSystemWorkspace(HOST_GOSA),
        );
    });

    it('composes the same way on the local desktop', () => {
        expect(systemWorkspaceRow(HOST_GOSA, LOCAL_HOME, false)).toEqual(
            makeSystemWorkspace(HOST_GOSA),
        );
    });

    it('falls back to the home directory on a desktop whose OSA spec has not resolved', () => {
        expect(systemWorkspaceRow(null, LOCAL_HOME, false)).toEqual(
            makeSystemWorkspace(LOCAL_HOME),
        );
    });

    it('POSITIVE CONTROL — a remote window never falls back to a LOCAL path', () => {
        // The rule that kept a wrong-machine chip off the screen, and the reason
        // the whole thing was refused remotely in the first place. It survives.
        expect(systemWorkspaceRow(null, LOCAL_HOME, true)).toBeNull();
    });

    it('POSITIVE CONTROL — with neither path there is no row, on either window', () => {
        expect(systemWorkspaceRow(null, null, false)).toBeNull();
        expect(systemWorkspaceRow(undefined, undefined, true)).toBeNull();
    });
});

