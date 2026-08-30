import { describe, expect, it } from 'vitest';
import { isGenieOsTerminalSpec, workspaceSurfaceRows, workspaceSurfaceSpecs } from '../genie';

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
