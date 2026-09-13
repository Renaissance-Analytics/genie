import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createDialogStartDir } from '../dialog-start-dir';

/**
 * Where a file or folder picker opens.
 *
 * Electron 43 changed the default: a `showOpenDialog` with no `defaultPath` now
 * opens in the user's Downloads folder. Before, the OS reopened wherever the user
 * last was. For Genie that turned "add another repo from the same projects folder"
 * into navigating out of Downloads every single time — a regression that came with
 * the upgrade, not a choice anyone made. So Genie remembers the last place itself.
 */

describe('createDialogStartDir', () => {
    it('adds nothing before anything has been picked, so the first picker opens where Electron chooses', () => {
        const dirs = createDialogStartDir();
        expect(dirs.apply({ title: 'Choose folder' })).toEqual({ title: 'Choose folder' });
    });

    it('reopens in the folder that CONTAINED the last pick', () => {
        // The user was browsing that folder; its sibling is the likely next pick.
        const dirs = createDialogStartDir();
        dirs.remember({ canceled: false, filePaths: [path.join('/projects', 'genie')] });
        expect(dirs.apply({ title: 'Choose folder' }).defaultPath).toBe(path.dirname(path.join('/projects', 'genie')));
    });

    it('never overrides a starting folder the caller asked for', () => {
        const dirs = createDialogStartDir();
        dirs.remember({ canceled: false, filePaths: [path.join('/projects', 'genie')] });
        expect(dirs.apply({ defaultPath: '/home/me' }).defaultPath).toBe('/home/me');
    });

    it('keeps the previous place when a picker is cancelled', () => {
        const dirs = createDialogStartDir();
        dirs.remember({ canceled: false, filePaths: [path.join('/projects', 'genie')] });
        dirs.remember({ canceled: true, filePaths: [] });
        expect(dirs.apply({}).defaultPath).toBe(path.dirname(path.join('/projects', 'genie')));
    });

    it('returns the picker result unchanged, so it can wrap a call in place', () => {
        const dirs = createDialogStartDir();
        const result = { canceled: false, filePaths: ['/a/b'] };
        expect(dirs.remember(result)).toBe(result);
    });
});
