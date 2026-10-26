import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { flowReach } from '../src/core/flow-reach.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowRecord } from '../src/main/flow-store.js';
import { FlowConfirm } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * WHAT A FILE FLOW WILL DO ONCE ARMED (genie#1204 item 5, with the Arm confirm of item 3): it runs on its own when a
 * matching file lands — the confirm says which files, where — and a move step says where they go. A file flow is not
 * "no schedule: it runs only when you start it", which would be untrue the moment it is armed.
 */

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const fileFlow = (trigger: Record<string, unknown>): FlowRecord => ({
    id: 'flow_big', workspaceId: 'tynn', name: 'big files out of git', armed: false,
    document: {
        $schema: FLOW_SCHEMA_URL, version: 1,
        graph: {
            nodes: [
                { id: 't', kind: 'genie/file_added', position: { x: 0, y: 0 }, config: { workspace: 'tynn', ...trigger } },
                { id: 'm', kind: 'genie/file_move', position: { x: 240, y: 0 }, config: { workspace: 'tynn', from: '{{in.path}}', to: '.untracked' } },
            ],
            edges: [{ id: 't-m', source: 't', target: 'm' }],
        },
    },
    createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [],
});

describe('the reach of a file flow', () => {
    it('names the files that start it — the workspace, the folder, the kinds, the size — and the move', () => {
        const reach = flowReach(fileFlow({ folder: 'uploads', extensions: 'png, .JPG', minSizeBytes: 5_000_000 }).document, NOW);
        expect(reach.schedule).toBeNull();
        expect(reach.file).toBe('a file is added to tynn, in uploads, .png or .jpg, 5 MB or more');
        expect(reach.steps).toEqual(['moves the file into .untracked']);
    });

    it('with no filters: any file added to the workspace', () => {
        expect(flowReach(fileFlow({}).document, NOW).file).toBe('a file is added to tynn');
    });

    it('CONTROL: a scheduled flow has no file reach', () => {
        const scheduled = { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } }], edges: [] } };
        expect(flowReach(scheduled, NOW).file).toBeNull();
    });
});

describe('the Arm confirm of a file flow', () => {
    it('says it runs on its own when such a file is added, and never that it has no schedule', () => {
        const html = renderToStaticMarkup(<FlowConfirm flow={fileFlow({ minSizeBytes: 5_000_000 })} kind="arm" now={NOW} onAction={() => {}} onCancel={() => {}} />);
        expect(html).toContain('It runs on its own when a file is added to tynn, 5 MB or more.');
        expect(html).toContain('moves the file into .untracked');
        expect(html).not.toMatch(/no schedule/);
    });
});
