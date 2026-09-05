/**
 * First-party Flow bodies — the actions an UNATTENDED Flow is allowed to take.
 *
 * `admission.ts` refuses every step type except `task` when nobody is watching,
 * and a `task` carries a function, which a stored JSON row cannot. So the only
 * thing a system-triggered Flow can ever run is one of the recipes in this file:
 * in-repo TypeScript, reviewed when it was written, reachable only by id.
 *
 * That is the same trust boundary `main/apps/flows/nodes.ts` draws for flow graphs —
 * a graph names a Genie tool structurally and cannot invent one — and it is what
 * makes "a trigger fired at 3am and something happened" a bounded statement
 * rather than an open one.
 *
 * ## Every recipe here declares its effects BEFORE causing them
 *
 * A recipe that writes a file will be reported back by the watcher as a
 * brand-new file, with no idea who wrote it. Declaring the write first is what
 * lets the loop guard recognise the echo (see `loop.ts`). Declaring it AFTER the
 * write leaves exactly the window in which the loop happens, so the ordering
 * below is load-bearing, not stylistic.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { FILE_ADDED_EVENT } from './file-source';
import type { FlowRecipe, FlowRecipeRef, FlowRunContext } from './types';

export const RELOCATE_FILE_RECIPE_ID = 'genie.relocate-file';

/** The recipe arg naming the workspace-relative folder to move files into. */
export const RELOCATION_DIR_ARG = 'relocateTo';

/** Where files go when the Flow does not say. */
export const DEFAULT_RELOCATION_DIR = '.genie/large-files';

/**
 * What makes the destination untracked.
 *
 * A folder that ignores its own contents, rather than an edit to the user's root
 * `.gitignore`. Two reasons: Genie is not entitled to rewrite a tracked file
 * somebody else owns, and a self-ignoring folder keeps working if it is moved,
 * copied, or the repo is reorganised around it.
 */
const SELF_IGNORING = [
    '# Written by a Genie Flow. Everything in this folder is deliberately',
    '# untracked -- it holds files moved out of the repository to keep it light.',
    '*',
    '',
].join('\n');

function requireString(ctx: FlowRunContext, key: string): string {
    const value = ctx.get(key);
    if (typeof value !== 'string' || value === '') {
        throw new Error(
            `"${RELOCATE_FILE_RECIPE_ID}" needs a "${key}", and this run did not supply one. ` +
                `It expects the props of a file event, or the same values as recipe args.`,
        );
    }
    return value;
}

/** True when `candidate` is `root` itself or sits underneath it. */
function isInside(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A destination that does not exist yet.
 *
 * Overwriting is not an option: the whole point is to keep a file, and two
 * unrelated `screenshot.png`s landing a week apart must not silently become one.
 * The suffix goes before the extension so the file stays openable.
 */
function freeDestination(dir: string, name: string): string {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let candidate = path.join(dir, name);
    for (let n = 1; fs.existsSync(candidate); n++) {
        candidate = path.join(dir, `${stem}-${n}${ext}`);
        if (n > 10_000) {
            throw new Error(`Cannot find a free name for "${name}" in "${dir}".`);
        }
    }
    return candidate;
}

/**
 * Move, across filesystems if need be.
 *
 * `rename` fails with EXDEV when the destination is on another device, which is
 * ordinary on a machine with a separate data volume. Falling back to copy+unlink
 * keeps the Flow working there; letting EXDEV surface would make it fail for
 * some users and not others with an error nobody could act on.
 */
async function move(source: string, destination: string): Promise<void> {
    try {
        await fsp.rename(source, destination);
        return;
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EXDEV') throw e;
    }
    await fsp.copyFile(source, destination);
    await fsp.unlink(source);
}

/**
 * Move the file this run is about into an untracked folder in the same
 * workspace.
 *
 * Reads `workspacePath` and `relPath` — the props a file event carries — and the
 * {@link RELOCATION_DIR_ARG} recipe arg.
 */
async function relocateFile(ctx: FlowRunContext): Promise<void> {
    const root = path.resolve(requireString(ctx, 'workspacePath'));
    const relPath = requireString(ctx, 'relPath');
    const relocateTo =
        typeof ctx.get(RELOCATION_DIR_ARG) === 'string' && ctx.get(RELOCATION_DIR_ARG) !== ''
            ? String(ctx.get(RELOCATION_DIR_ARG))
            : DEFAULT_RELOCATION_DIR;

    const source = path.resolve(root, relPath);
    if (!isInside(root, source)) {
        throw new Error(`"${relPath}" resolves outside the workspace; refusing to move it.`);
    }

    const destinationDir = path.resolve(root, relocateTo);
    if (!isInside(root, destinationDir)) {
        throw new Error(
            `"${relocateTo}" resolves outside the workspace. A Flow moves files WITHIN a ` +
                `workspace; moving them out of it is a different, more dangerous thing.`,
        );
    }

    // Already where it belongs. Not an error, and the reason a naive re-trigger
    // could never cause damage even if the loop guard were somehow bypassed.
    if (isInside(destinationDir, source)) {
        ctx.set('relocated', false);
        ctx.set('relocatedReason', 'the file is already in the destination folder.');
        return;
    }

    // The file may have been deleted or moved between the event and this run —
    // ordinary on a busy machine, and not a failure of anything.
    if (!fs.existsSync(source)) {
        ctx.set('relocated', false);
        ctx.set('relocatedReason', 'the file was gone by the time the Flow ran.');
        return;
    }

    const destination = freeDestination(destinationDir, path.basename(relPath));
    const ignoreFile = path.join(destinationDir, '.gitignore');
    const needsIgnore = !fs.existsSync(ignoreFile);

    // BEFORE the writes, never after. The window between writing and declaring
    // is exactly the window in which the Flow retriggers itself.
    ctx.declareEffect({ event: FILE_ADDED_EVENT.id, match: { path: destination } });
    if (needsIgnore) {
        ctx.declareEffect({ event: FILE_ADDED_EVENT.id, match: { path: ignoreFile } });
    }

    await fsp.mkdir(destinationDir, { recursive: true });
    if (needsIgnore) await fsp.writeFile(ignoreFile, SELF_IGNORING, 'utf8');
    await move(source, destination);

    ctx.set('relocated', true);
    ctx.set('relocatedTo', destination);
}

/**
 * The reference case's body: keep a repository light by moving heavy files into
 * an untracked folder beside it.
 *
 * One task step, on purpose. Everything about WHEN it runs — over 5 MB, in this
 * workspace, not for files it moved itself — is the Flow's triggers and filter,
 * not this recipe's business.
 */
export const relocateFileRecipe: FlowRecipe = {
    id: RELOCATE_FILE_RECIPE_ID,
    title: 'Move the file into an untracked folder',
    // Said in the first person about the USER's files, because that is whose
    // files they are. Anything arming this shows this sentence first.
    consequence:
        'Moves files out of your workspace into an untracked folder, without asking again.',
    purpose: 'Files',
    // What `relocateFile` above reads off `ctx`, said out loud. The two
    // `fromEvent` inputs are the props a file event carries; declaring them is
    // what stops somebody authoring a manual-only Flow on this body, whose Run
    // button could only ever throw at `requireString`.
    inputs: [
        {
            key: 'workspacePath',
            type: 'string',
            label: 'Workspace root',
            description: 'The workspace the file is in. A file event supplies this.',
            required: true,
            fromEvent: true,
        },
        {
            key: 'relPath',
            type: 'string',
            label: 'File',
            description:
                'The file to move, relative to the workspace root. A file event supplies this.',
            required: true,
            fromEvent: true,
        },
        {
            key: RELOCATION_DIR_ARG,
            type: 'string',
            label: 'Move files into',
            description:
                'A folder inside the workspace. It is created if it does not exist, and ' +
                'ignores its own contents so the files stay untracked.',
            default: DEFAULT_RELOCATION_DIR,
        },
    ],
    steps: [
        {
            type: 'task',
            id: 'relocate',
            title: 'Move the file out of the repository',
            run: relocateFile,
        },
    ],
};

/** Every first-party Flow body, by id. */
export const BUILT_IN_FLOW_RECIPES: ReadonlyMap<string, FlowRecipe> = new Map([
    [relocateFileRecipe.id, relocateFileRecipe],
]);

/**
 * A Flow's stored reference resolved to the body it names.
 *
 * One function rather than the same `.get(ref.recipeId) ?? null` written at each
 * caller: the runtime resolves a body to RUN it and the store resolves one to
 * validate against, and those two must never disagree about which recipe an id
 * means.
 */
export function resolveBuiltInRecipe(ref: FlowRecipeRef): FlowRecipe | null {
    return BUILT_IN_FLOW_RECIPES.get(ref.recipeId) ?? null;
}
