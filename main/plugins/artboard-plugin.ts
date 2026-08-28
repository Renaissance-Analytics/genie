import type { BundledPluginSource } from './official';

/**
 * ArtBoard — the bundled plugin definition.
 *
 * Kept in its own module rather than inlined beside the others because its tool
 * source is long enough that embedding it in `official.ts` buries the list of
 * what Genie ships.
 *
 * WHAT IT IS FOR: an agent that has MADE something visual has no way to show it.
 * It can describe the thing in words through ForceTheQuestion, which is exactly
 * what a review surface exists to avoid — you cannot review a mockup from a
 * paragraph about the mockup. ArtBoard gives it somewhere to put the artifact
 * and a way to hear back.
 *
 * WHAT IT IS NOT FOR: plans, proposals, written summaries. Those are text, they
 * read better in a message or a document, and letting them onto the board turns
 * a place for looking at things into a second inbox.
 *
 * The worker is filesystem-only, so the split is: the agent WRITES the artifact
 * and the index; Genie's first-party `ArtBoardPanel` READS them; the verdict
 * returns as an AgentInbox message. Nothing polls, and the plugin ships no UI.
 */

/**
 * The `tools.cjs` module. Plain CommonJS — no backticks or `${` (it lives inside
 * a template literal) and no raw backslash (a backslash is built from its char
 * code where one is needed).
 */
const ARTBOARD_TOOLS = `// ArtBoard - an agent posts what it MADE so a human can look at it and decide.
// Filesystem-only, like every plugin worker: this writes the artifact and the
// index, and Genie's first-party ArtBoardPanel reads them. The verdict comes
// back as an AgentInbox message, so nothing here polls.
var NL = String.fromCharCode(10);
var BACKSLASH = String.fromCharCode(92);
var DIR = '.artboard';
var INDEX = DIR + '/index.json';
var MAX = 100;

function slug(s) {
    var v = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return v || 'post';
}

// A BARE filename inside the board dir. The panel loads whatever this names, so
// anything that could climb out of the directory is refused HERE too, not only
// when the panel parses the index - the write is the cheaper place to stop it.
function safeName(name) {
    var v = String(name || '');
    if (!v) return false;
    if (v.indexOf('/') >= 0) return false;
    if (v.indexOf(BACKSLASH) >= 0) return false;
    if (v.indexOf('..') >= 0) return false;
    return true;
}

async function readIndex(bridge) {
    try {
        var raw = await bridge.fs.readFile(INDEX);
        var parsed = JSON.parse(String(raw || ''));
        return (parsed && Array.isArray(parsed.posts)) ? parsed.posts : [];
    } catch (e) {
        // No board yet, or one a previous write left half-formed. Either way the
        // right answer is an empty board, not a failed post.
        return [];
    }
}

async function post(args, bridge, ctx) {
    var input = (args && typeof args === 'object') ? args : {};
    var title = (typeof input.title === 'string' && input.title.trim()) ? input.title.trim() : '';
    if (!title) {
        return { isError: true, content: [{ type: 'text', text: 'A post needs a title - it is what the reviewer sees on the card.' }] };
    }

    var kind = input.kind === 'image' ? 'image' : 'html';
    var id = (typeof input.id === 'string' && input.id.trim()) ? slug(input.id) : slug(title);
    var file;

    if (kind === 'html') {
        var html = (typeof input.html === 'string') ? input.html : '';
        if (!html.trim()) {
            return { isError: true, content: [{ type: 'text', text: 'An html post needs the markup in html.' }] };
        }
        file = id + '.html';
        if (!safeName(file)) {
            return { isError: true, content: [{ type: 'text', text: 'That id produces an unusable filename. Use letters, numbers and dashes.' }] };
        }
        await bridge.fs.writeFile(DIR + '/' + file, html);
    } else {
        var from = (typeof input.imagePath === 'string') ? input.imagePath.trim() : '';
        if (!from) {
            return { isError: true, content: [{ type: 'text', text: 'An image post needs imagePath - a workspace-relative path to the image you generated.' }] };
        }
        var dot = from.lastIndexOf('.');
        var ext = dot > 0 ? from.slice(dot).toLowerCase() : '.png';
        file = id + ext;
        if (!safeName(file)) {
            return { isError: true, content: [{ type: 'text', text: 'That id produces an unusable filename. Use letters, numbers and dashes.' }] };
        }
        // COPIED into the board, not referenced. The reviewer must still see what
        // was posted after the agent has moved on and rewritten its own output.
        var bytes = await bridge.fs.readBytes(from);
        await bridge.fs.writeBytes(DIR + '/' + file, bytes);
    }

    var entry = {
        id: id,
        title: title,
        kind: kind,
        file: file,
        createdAt: new Date().toISOString()
    };
    // The terminal is HOST-supplied (worker-host passes it into every call), never
    // taken from args - a post must not be able to ask for someone else's verdict
    // to be routed to it.
    if (ctx && typeof ctx.terminalId === 'string' && ctx.terminalId) entry.terminalId = ctx.terminalId;
    if (typeof input.note === 'string' && input.note.trim()) entry.note = input.note.trim();

    var posts = await readIndex(bridge);
    var rest = posts.filter(function (p) { return p && p.id !== id; });
    var next = [entry].concat(rest).slice(0, MAX);
    await bridge.fs.writeFile(INDEX, JSON.stringify({ posts: next }, null, 2));

    return {
        _meta: { geniePanel: { panelId: 'board', activeItemId: id } },
        content: [{
            type: 'text',
            text: 'Posted "' + title + '" to the ArtBoard as ' + id + '.' + NL +
                'Genie opened and focused the ArtBoard panel on this artifact. The reviewer can approve or reject it with a comment. That verdict arrives here as an AgentInbox message, so this call does NOT block - carry on with work that does not depend on the answer and check your inbox.' + NL +
                'Revising? Post again with id "' + id + '" and the board REPLACES that card instead of stacking a second one beside it.'
        }]
    };
}

module.exports = { post: post };
`;

export const ARTBOARD_SOURCE: BundledPluginSource = {
    id: 'ai.genie.artboard',
    name: 'ArtBoard',
    description: 'Post a mockup or an image for a human to review, and hear the verdict.',
    manifest: {
        id: 'ai.genie.artboard',
        namespace: 'artboard',
        name: 'ArtBoard',
        version: '0.1.0',
        description:
            'A review surface for what agents MAKE. An agent posts a rendered HTML mockup or an image it generated; the human sees it in the ArtBoard panel and approves or rejects it with an optional comment, and that verdict is delivered back to the posting agent. For finished artifacts to LOOK at — not plans or written proposals, which read better as text.',
        publisher: { name: 'Genie', url: 'https://github.com/Renaissance-Analytics/genie' },
        engines: { genie: '>=0.7.0' },
        entry: { tools: 'tools.cjs' },
        agent: {
            guide:
                'Use artboard.post when you have MADE something visual and want a human to look at it before going further — a rendered mockup, a generated image. NOT for plans, proposals or written summaries: those are text and belong in a message or a document. Give a post a stable id and RE-POST with the same id when you revise, so the board replaces the card instead of stacking drafts. Posting opens and focuses the ArtBoard panel on that artifact but does not block — the approve/reject verdict arrives as an AgentInbox message, so continue with work that does not depend on the answer.',
        },
        contributes: {
            mcpTools: [
                {
                    name: 'post',
                    description:
                        'Put something you MADE on the ArtBoard for a human to review — a rendered HTML mockup, or an image you generated. Not for plans or written proposals. Provide a title and either `html` (the markup) or `imagePath` (workspace-relative). Pass a stable `id` and re-post with the same id to REPLACE that card when you revise. Genie opens and focuses the panel on the posted artifact. Returns immediately; the approve/reject verdict, with any comment, arrives as an AgentInbox message.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'What the reviewer sees on the card.' },
                            kind: { type: 'string', enum: ['html', 'image'], description: 'html (default) or image.' },
                            html: { type: 'string', description: 'For kind html: the full markup to render.' },
                            imagePath: {
                                type: 'string',
                                description: 'For kind image: workspace-relative path to the image you generated. It is COPIED onto the board.',
                            },
                            id: { type: 'string', description: 'Stable id. Re-posting with the same id REPLACES that card.' },
                            note: { type: 'string', description: 'One line on what you want looked at.' },
                        },
                        required: ['title'],
                    },
                    run: 'tools',
                    process: 'worker',
                    gated: false,
                },
            ],
            panels: [
                {
                    id: 'board',
                    title: 'ArtBoard',
                    icon: 'image',
                    // DECLARED, vetted, Genie-bundled: the plugin ships no UI. The
                    // renderer resolves this export through its compile-time adapter
                    // registry to the first-party ArtBoardPanel, built from
                    // react-fancy primitives Genie already bundles.
                    fancyComponent: {
                        package: '@particle-academy/fancy-artboard',
                        version: '>=0.5.0',
                        export: 'ArtBoard',
                    },
                },
            ],
        },
        capabilities: {
            // The board lives in the workspace, so the worker needs the workspace
            // fs scope — extension-limited to what a post can actually be.
            fs: {
                scope: 'workspace',
                extensions: ['.json', '.html', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'],
            },
            genieApi: ['ui.panel'],
        },
    },
    tools: ARTBOARD_TOOLS,
};
