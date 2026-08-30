import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTerminalSpec, initDatabase } from '../db';

beforeAll(() => initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-plugin-panel-'))));

describe('plugin panel persistence', () => {
    it('round-trips plugin-panel instead of degrading it to a terminal', () => {
        const spec = createTerminalSpec({
            id: 'artboard-panel', workspace_id: null, label: 'artboard', cwd: os.tmpdir(),
            type: 'plugin-panel', meta: { plugin_id: 'ai.genie.artboard', panel_id: 'board' },
        });
        expect(spec.type).toBe('plugin-panel');
    });
});
