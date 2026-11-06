import { expect, it } from 'vitest';
import { WorkspaceColors, type WorkspaceColorsOptions } from '../src/main/workspace-color-host.js';

it('story394: a queued colour pass checks current hibernation before reading a captured folder, and reads it on redock', async () => {
    const reads: string[] = [];
    let release!: () => void;
    let asleep = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const options = { fs: {
        readText: async (path: string) => { reads.push(path); if (first) { first = false; await held; } return null; },
        writeTextAtomic: async () => { throw new Error('no manifest exists to write in this fixture'); },
    }, onChanged: () => {}, mayReadFolder: (path: string) => path !== '/ghost' || !asleep } as WorkspaceColorsOptions;
    const colors = new WorkspaceColors(options);
    const active = { id: 'awake', path: '/awake' }, ghost = { id: 'ghost', path: '/ghost' };
    const running = colors.ensure([active]);
    void colors.ensure([active, ghost]);
    asleep = true; release();
    await running;
    expect(reads).toContain('/awake/project.json');
    expect(reads).not.toContain('/ghost/project.json');
    expect(colors.colorOf('/ghost')).toBeNull();
    asleep = false; await colors.ensure([active, ghost]);
    expect(reads).toContain('/ghost/project.json');
    expect(colors.colorOf('/ghost')).not.toBeNull();
});
