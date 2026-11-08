import { applyTreeChanges } from '../core/local-files-watch.js';
import type { FilesHubEvent } from './files-watch-hub.js';
import type { GitTreeState } from './git-ports.js';

type Tree = Readonly<Record<string, GitTreeState>>;

/**
 * THE WINDOW'S COPY OF EACH WORKSPACE'S GIT TREE (Tynn #524). genie-host sends a window the whole tree once, then only what
 * changed since (files-watch-hub.ts). This keeps the tree per workspace and turns each event back into the whole tree
 * its listeners expect, with the tree before it and what changed (`changes`), so a view's push never diffs it again
 * (local-files-watches.ts). Changes with no tree to apply them to (nothing was kept) are not guessed at: the event goes
 * on without a tree, said once per workspace.
 */
export class FilesTreeKeeper {
    readonly #trees = new Map<string, Tree>();
    readonly #told = new Set<string>();
    readonly #log: (line: string) => void;

    constructor(log: (line: string) => void = () => {}) { this.#log = log; }

    accept(event: FilesHubEvent): FilesHubEvent {
        if (event.kind !== 'git') return event;
        const { treeChanges, ...rest } = event;
        if (event.tree) { this.#trees.set(event.workspaceId, event.tree); return event; }
        if (!treeChanges) return event;
        const prev = this.#trees.get(event.workspaceId);
        if (!prev) {
            if (true) { this.#log(`files git: changes to a tree this window does not hold (${event.workspaceId}); sent on without a tree`); }
            return rest;
        }
        const tree = applyTreeChanges(prev, treeChanges);
        this.#trees.set(event.workspaceId, tree);
        return { ...rest, tree, changes: { prev, set: treeChanges.set, removed: treeChanges.removed } };
    }

    /** The link to genie-host was replaced: the next tree it sends is whole, and is the one kept. */
    reset(): void { this.#trees.clear(); this.#told.clear(); }
}
