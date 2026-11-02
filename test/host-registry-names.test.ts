import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugsFor } from '../src/core/address.js';
import { workspaceDisplayName } from '../src/core/workspace-name.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { Store } from '../src/main/store.js';

/**
 * A WORKSPACE'S ADDRESS IS ITS NAME, IN THE HOST TOO (the host split, P3.3a; the known gap P3.2 left). The slug an agent's
 * address uses (`atlas@tynn`) comes from the workspace's NAME — project.json's `name`, else the folder — which the window
 * read and told the host. With no window since the host started, the host stood the folder name in, so an address the
 * person's window shows did not resolve in the host. The host reads project.json itself now, the way the window does.
 */

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe('the host names workspaces from their project.json', () => {
    it('with NO window: the slug is project.json\'s name, the same one the window computes; a folder with none keeps its folder name', async () => {
        const home = await mkdtemp(join(tmpdir(), 'host-names-'));
        const named = await mkdtemp(join(tmpdir(), 'folder-xyz-'));
        const plain = await mkdtemp(join(tmpdir(), 'plainfolder-'));
        dirs.push(home, named, plain);
        await writeFile(join(named, 'project.json'), JSON.stringify({ name: 'Tynn.ai' }));
        const store = new Store(home);
        await store.writeWorkspaces([{ id: 'w1', path: named }, { id: 'w2', path: plain }]);
        const registry = new HostRegistry(store);
        await registry.refresh();
        // What the window computes for the same workspaces (main.ts workspaceNameFor → Registry.workspaceSlugs).
        const window = slugsFor([named, plain].map((path, i) => ({ id: `w${i + 1}`, path, name: workspaceDisplayName(path === named ? JSON.stringify({ name: 'Tynn.ai' }) : null, path) })));
        expect(registry.workspaceSlugs()).toEqual(window);
        expect(registry.workspaceSlugs().get('w1')).not.toBe(slugsFor([{ id: 'w1', path: named, name: named.split(/[\\/]/).pop()! }]).get('w1')); // CONTROL: not the folder's
    });
});
