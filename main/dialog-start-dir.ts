import path from 'node:path';

/**
 * Where Genie's file and folder pickers open.
 *
 * Electron 43 made a `showOpenDialog` with no `defaultPath` open in the user's
 * Downloads folder. Before that the OS reopened wherever the user last was, which
 * is what adding a second repo from the same projects folder depends on. Genie now
 * remembers that place itself: the folder that contained the last pick.
 *
 * One instance is shared by every picker in the process, as the OS's memory was.
 * It lasts for the session; the first picker after a restart opens where Electron
 * chooses.
 */
export interface DialogStartDir {
    /** The options with the remembered folder as `defaultPath`, unless the caller set one.
     *  (An intersection, not `T extends { defaultPath?: string }`: an all-optional
     *  constraint is a weak type, and dialog options without a `defaultPath` share
     *  no property with it, so inference would reject them.) */
    apply<T extends object>(options: T & { defaultPath?: string }): T & { defaultPath?: string };
    /** Record a picker's result, and return it unchanged. */
    remember<R extends { canceled: boolean; filePaths: string[] }>(result: R): R;
}

export function createDialogStartDir(): DialogStartDir {
    let last: string | undefined;
    return {
        apply(options) {
            if (options.defaultPath || !last) return options;
            return { ...options, defaultPath: last };
        },
        remember(result) {
            const picked = result.canceled ? undefined : result.filePaths[0];
            if (picked) last = path.dirname(picked);
            return result;
        },
    };
}

/** The picker memory every Genie dialog shares. */
export const dialogStartDir = createDialogStartDir();
