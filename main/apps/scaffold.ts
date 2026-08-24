/**
 * PURE. Creating a Genie App from nothing (Tynn #250, P2).
 *
 * The requirement is that the SDK teach an agent to "fill a gap". Documentation is
 * half of that; the other half is a starting point that is already correct,
 * because the first thing anyone does — human or agent — is copy what is in front
 * of them. A scaffold that casually asked for `terminals` would teach every app
 * built from it to ask for `terminals`.
 *
 * So the starting point is an app that can do NOTHING: `scope: self`, no
 * capabilities. Every permission in a finished app is then one somebody
 * deliberately added and can explain.
 *
 * Returns the files to write rather than writing them, so what it produces can be
 * run through Genie's REAL validator in a test. A scaffold that does not pass the
 * gate it is scaffolding for is worse than no scaffold at all.
 */

import { RESERVED_APP_NAMES } from './manifest';

export interface ScaffoldOptions {
    /** The human name. Becomes the slug, and the address. */
    name: string;
    /** Reverse-DNS id. */
    id: string;
}

export interface ScaffoldFile {
    /** Folder-relative, forward slashes. */
    path: string;
    contents: string;
}

/**
 * A human name → a DNS label, since the slug becomes `<slug>.gen`.
 *
 * Falls back rather than returning empty: a name of pure punctuation would
 * slugify to nothing, and an empty slug is a site that cannot be served.
 */
export function slugify(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63)
        .replace(/-+$/g, '');
    return slug || 'my-app';
}

export function scaffoldApp(options: ScaffoldOptions): ScaffoldFile[] {
    const name = options.name.trim();
    // Refuse here rather than writing files for an app that install would reject —
    // the developer would find out one step later, with a folder to clean up.
    if (RESERVED_APP_NAMES.includes(name.toLowerCase().replace(/\s+/g, ' '))) {
        throw new Error(
            `“${name}” is a reserved name — a Genie App may not be called that. Pick another.`,
        );
    }

    const slug = slugify(name);

    const manifest = {
        id: options.id,
        slug,
        name,
        version: '0.1.0',
        description: `${name} — a Genie App.`,
        frontend: {
            repo: 'web',
            serve: { mode: 'static', root: '.' },
        },
        // Start with NOTHING. Add a capability when the app needs it, and be ready
        // to say why on the consent screen.
        permissions: { scope: 'self', capabilities: [] },
    };

    return [
        { path: 'genie-app.json', contents: `${JSON.stringify(manifest, null, 4)}\n` },
        { path: 'web/index.html', contents: indexHtml(name) },
        { path: 'README.md', contents: readme(name, slug) },
    ];
}

function indexHtml(name: string): string {
    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${name}</title>
        <style>
            :root { color-scheme: dark; }
            body {
                margin: 0;
                padding: 2rem;
                background: #0a0a0c;
                color: #e8e8ec;
                font: 15px/1.55 ui-sans-serif, system-ui, sans-serif;
            }
            main { max-width: 40rem; margin: 0 auto; }
            code { color: #a1a1aa; }
        </style>
    </head>
    <body>
        <main>
            <h1>${name}</h1>
            <p id="status">Starting…</p>
        </main>
        <script type="module">
            // Genie exposes exactly two calls, and only inside a Genie App window.
            const genie = globalThis.genieApp;
            const status = document.getElementById('status');

            if (!genie) {
                // Opening this page outside Genie is normal while you build it.
                status.textContent =
                    'Not running in a Genie App window — install this folder in Genie to see it work.';
            } else {
                const me = await genie.me();
                status.textContent = \`Running as \${me.name}, in workspace \${me.workspaceId}.\`;

                // THE PATTERN TO COPY: ask what the user granted, then render.
                // A control that always fails teaches them the app is broken; one
                // that is not there teaches them it is restricted.
                if (me.capabilities.includes('hosting')) {
                    const sites = await genie.call('manageSite', { action: 'list' });
                    console.log('sites', sites);
                }
            }
        </script>
    </body>
</html>
`;
}

function readme(name: string, slug: string): string {
    return `# ${name}

A Genie App. Install it with **Settings → Genie Apps → Install an app…** and point
it at this folder.

- Served at \`https://${slug}.gen/\` once installed.
- \`genie-app.json\` declares what it is and what it may do.
- \`web/\` is the front end Genie serves.

## Asking for a permission

\`permissions.capabilities\` starts EMPTY — this app can do nothing, which is the
right default. Add one when you need it, and be ready for the user to decline:

\`\`\`json
"permissions": { "scope": "self", "capabilities": ["hosting"] }
\`\`\`

Then check for it before you offer the feature:

\`\`\`js
const me = await genieApp.me();
if (me.capabilities.includes('hosting')) { /* show the control */ }
\`\`\`

## Adding a backend

\`\`\`json
"services": [
  { "name": "api", "repo": "service", "command": ["node", "server.mjs"], "port": 8791 }
]
\`\`\`

\`command\` is a literal argv array, never a shell string.

## Before you ship it

**Settings → Genie Apps → Check an app…**, pointed at this folder, runs the whole
Genie App suite without installing anything: the manifest through the real
validator, every path it declares, the agents against the panels that can run
them, and the front end against the API a Genie App window actually has.

An app can be schema-valid, install without an error, and still open on an empty
window. The check is what tells you — and it tells you where, what, and what to do
about it. Run it after every change.

Full reference: \`packages/app-sdk/README.md\` in the Genie repo.
`;
}
