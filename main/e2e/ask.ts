/**
 * E2E fixture for the ForceTheQuestion modal (Tynn story #272).
 *
 * The window under test is NOT a harness page: `showE2EWindow` hands off to this
 * file, which raises REAL questions through `forceQuestion`, so the window
 * Playwright attaches to is the product's own modal — created by
 * `createAskWindow`, with its navigation guard, its queue, and its drawer resize
 * all live. Nothing here fakes the modal; it only supplies what an agent would.
 *
 * Two questions are raised, in order, and the queue advances between them when
 * the spec answers the first. That pairing is the point: "the question body
 * grows instead of scrolling" passes just as well against a layout that only
 * ever renders one size, so the suite has to see a LONG question and a SHORT one
 * in the same window.
 *
 * A real file is written to a real workspace root, because the drawer reads
 * through the production `files:read` handler, which resolves paths against the
 * workspace and refuses anything outside it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addWorkspace, getWorkspace, removeWorkspace } from '../db';
import { forceQuestion } from '../ask/force-question';

const WORKSPACE_ID = 'e2e-ask';
const WORKSPACE_NAME = 'Ask Fixture';

/** The file the LONG question names — read by the drawer, so it must exist. */
export const ASK_FIXTURE_FILE = '.ai/plans/spec.md';
/** A line the spec looks for in the drawer, distinctive enough to be no accident. */
export const ASK_FIXTURE_MARKER = 'Bridges are named after the river they cross.';
/**
 * The fixture file's H1. It is asserted as a RENDERED heading (genie#603): the
 * drawer showed markdown as a code buffer, and `# Action catalog` reaching the
 * screen as text proves nothing — it did that while the bug was open.
 */
export const ASK_FIXTURE_HEADING = 'Action catalog';

const LONG_PARAGRAPH =
    'The action catalog is the list of things an agent may do without asking, ' +
    'and it is the only place that list is written down. Everything else — the ' +
    'gates, the prompts, the audit trail — reads from it.';

/**
 * A question long enough that the modal cannot show it all at once. It has to be
 * genuinely long: a question that happens to fit proves nothing about growth.
 */
function longQuestion(): string {
    const body = Array.from(
        { length: 12 },
        (_, i) => `### Point ${i + 1}\n\n${LONG_PARAGRAPH}\n`,
    ).join('\n');
    return (
        `Does §3 of \`${ASK_FIXTURE_FILE}\` still describe what we are building?\n\n` +
        `${body}\n` +
        'Answer with the option that matches what you want to happen next.'
    );
}

function shortQuestion(): string {
    return `One line, nothing more. See \`${ASK_FIXTURE_FILE}\`.`;
}

export interface AskFixture {
    workspaceId: string;
    workspacePath: string;
    /** The absolute path of the file the questions name. */
    filePath: string;
}

/** Where the fixture workspace lives on disk (recreated every run). */
function fixtureRoot(): string {
    return path.join(os.tmpdir(), 'genie-e2e-ask-workspace');
}

export function seedAskE2E(): AskFixture {
    const root = fixtureRoot();
    const filePath = path.join(root, ...ASK_FIXTURE_FILE.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Rewritten every run: a spec that asserts on the marker must not pass
    // against whatever a previous run happened to leave behind.
    //
    // TALLER THAN THE DRAWER, on purpose (genie#603). The drawer clipped instead
    // of scrolling, and a file that fits cannot demonstrate the difference: the
    // pane looks identical whether it scrolls or throws the overflow away. The
    // sections in between exist to push §3 past the fold, and every paragraph is
    // one long unbroken LINE so the same file also answers whether it wraps.
    const filler = Array.from(
        { length: 24 },
        (_, i) => `## ${i + 2}. Section ${i + 2}\n\n${LONG_PARAGRAPH}\n`,
    ).join('\n');
    fs.writeFileSync(
        filePath,
        [
            `# ${ASK_FIXTURE_HEADING}`,
            '',
            '## 1. Scope',
            '',
            LONG_PARAGRAPH,
            '',
            filler,
            '## 3. Naming',
            '',
            ASK_FIXTURE_MARKER,
            '',
        ].join('\n'),
        'utf8',
    );

    // The E2E profile is reused across runs — replace rather than accumulate.
    if (getWorkspace(WORKSPACE_ID)) removeWorkspace(WORKSPACE_ID);
    addWorkspace({
        id: WORKSPACE_ID,
        backend: 'aionima',
        project_id: WORKSPACE_ID,
        project_name: WORKSPACE_NAME,
        tynn_project_id: WORKSPACE_ID,
        tynn_project_name: WORKSPACE_NAME,
        shape: 'simple',
        path: root,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        sort_order: 0,
    });

    const fixture: AskFixture = { workspaceId: WORKSPACE_ID, workspacePath: root, filePath };
    (globalThis as Record<string, unknown>).__GENIE_E2E_ASK__ = fixture;
    return fixture;
}

/**
 * Raise the two fixture questions, LONG first. Both go through the ordinary
 * `forceQuestion` path with the fixture workspace as their scope, so the modal
 * receives the workspace root the drawer resolves file paths against.
 *
 * The promises are deliberately left to resolve on their own: the spec answers
 * or cancels through the real UI, and nothing here needs the answer.
 */
export function raiseAskE2E(): void {
    const scope = { workspaceId: WORKSPACE_ID };
    void forceQuestion(
        [
            {
                header: 'Long question',
                question: longQuestion(),
                options: [
                    { label: 'Yes, it still holds', description: 'Nothing to change' },
                    { label: 'No, it has drifted', description: 'The spec needs a revision' },
                ],
            },
        ],
        WORKSPACE_NAME,
        'normal',
        scope,
    ).catch(() => {});
    void forceQuestion(
        [
            {
                header: 'Short question',
                question: shortQuestion(),
                options: [{ label: 'Understood' }, { label: 'Not yet' }],
            },
        ],
        WORKSPACE_NAME,
        'normal',
        scope,
    ).catch(() => {});
}
