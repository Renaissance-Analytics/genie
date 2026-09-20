import { describe, expect, it } from 'vitest';
import { withoutHibernatedPanelSpecs } from '../hibernated-panels';

const ws = (id: string, hibernated_at: number | null = null) => ({ id, hibernated_at });
const spec = (id: string, workspace_id: string | null) => ({ id, workspace_id });

describe('withoutHibernatedPanelSpecs — sleeping workspace panels are closed', () => {
    it('removes panels belonging to a hibernated workspace without hiding real unattached panels', () => {
        const specs = [
            spec('awake-panel', 'awake'),
            spec('sleeping-panel', 'asleep'),
            spec('unattached-panel', null),
            spec('missing-workspace-panel', 'deleted'),
        ];

        expect(
            withoutHibernatedPanelSpecs(specs, [ws('awake'), ws('asleep', 1)]).map(
                (panel) => panel.id,
            ),
        ).toEqual(['awake-panel', 'unattached-panel', 'missing-workspace-panel']);
    });

    it('returns a workspace panel when that workspace wakes up', () => {
        const specs = [spec('panel', 'workspace')];

        expect(withoutHibernatedPanelSpecs(specs, [ws('workspace')])).toEqual(specs);
    });
});
