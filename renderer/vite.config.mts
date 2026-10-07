import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { THEME_BOOT_SCRIPT } from './lib/theme-boot';

/**
 * The renderer build — Vite, not Next (owner directive, Tynn #449).
 *
 * Next was doing exactly one job here: emitting static HTML the packaged app loads over
 * `file://`. This does that job directly, and two things fall out of it:
 *
 * **The E2E harness pages stop shipping.** `renderer/pages/e2e-*.tsx` are local test rigging
 * — each mounts one component in isolation for Playwright. Under Next's `output: 'export'`
 * every page became static HTML in the installer, so 13 unreachable pages shipped to users
 * because nothing excluded them. Here they are only built under `--mode e2e`.
 *
 * **`_app.tsx` / `_document.tsx` are gone.** Their jobs moved to `shell.tsx` (global CSS +
 * live theme sync) and to the HTML template below (the pre-paint theme script).
 *
 * ## Two things that will silently break the packaged app if changed
 *
 * **`base: './'`.** Absolute asset paths 404 under `file://`, and the renderer then hangs
 * forever on "Waiting for preload bridge…" because its React bundle never runs. This is the
 * failure Next's `assetPrefix: './'` existed to prevent, and it fails with no error.
 *
 * **The theme script must stay a plain inline, blocking `<script>` in `<head>`.** Genie's
 * dark palette hangs off a `.dark` class, so an unclassed `<html>` is the LIGHT theme, and
 * every page ships a prerendered full-window `.boot-screen` whose light variant is near
 * white. Resolving the theme after paint painted a white full-screen window until hydration
 * (genie#229). No `defer`, no `async`, no module — any of those stop it being pre-paint and
 * the flash returns.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(here, 'pages');

/** `renderer/pages/<name>.tsx` → page name, minus Next's underscore files. */
function discoverPages(includeHarnesses: boolean): string[] {
    return fs
        .readdirSync(PAGES_DIR)
        .filter((f) => f.endsWith('.tsx') && !f.startsWith('_'))
        .map((f) => f.replace(/\.tsx$/, ''))
        .filter((name) => includeHarnesses || !name.startsWith('e2e-'))
        .sort();
}

/**
 * The page shell.
 *
 * `genie-theme-root` on <html> and the blocking script are both load-bearing — see the note
 * above. `#root` is what `mountPage` looks for.
 */
function pageHtml(scripts: string, styles: string): string {
    return `<!doctype html>
<html class="genie-theme-root">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script>${THEME_BOOT_SCRIPT}</script>
${styles}
</head>
<body>
<div id="root"></div>
${scripts}
</body>
</html>
`;
}

const VIRTUAL = 'virtual:genie-page/';

/**
 * One entry per page, and one HTML file per entry.
 *
 * The entry is VIRTUAL rather than a real file per page: 25 near-identical mount files would
 * be boilerplate that can drift, and a page whose wrapper was subtly different from the rest
 * is exactly the kind of difference nobody notices.
 */
function geniePages(pages: string[]): Plugin {
    return {
        name: 'genie-pages',

        resolveId(id) {
            return id.startsWith(VIRTUAL) ? `\0${id}` : null;
        },

        load(id) {
            if (!id.startsWith(`\0${VIRTUAL}`)) return null;
            const page = id.slice(`\0${VIRTUAL}`.length);
            // The page's default export is the component; the shell supplies everything
            // `_app.tsx` used to.
            return [
                `import Page from '/pages/${page}.tsx';`,
                `import { mountPage } from '/shell.tsx';`,
                `mountPage(Page);`,
            ].join('\n');
        },

        /**
         * Emit `<page>.html` for each entry.
         *
         * Vite's own HTML pipeline is not used, because that needs a real HTML file per page
         * as input — the thing this plugin exists to avoid. So the tags are written here from
         * the bundle, which is also what keeps the paths RELATIVE.
         */
        generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
                const page = chunk.name;
                if (!pages.includes(page)) continue;

                // CSS must be collected TRANSITIVELY. The stylesheets are imported by
                // `shell.tsx`, which is a SHARED chunk rather than the entry — so the
                // entry's own `importedCss` is empty, and reading only that emitted pages
                // with no <link> at all. Measured: 315 kB of CSS built and referenced by
                // nothing, so the app rendered completely unstyled with no error.
                const seen = new Set<string>();
                const cssFiles = new Set<string>();
                const walk = (name: string) => {
                    if (seen.has(name)) return;
                    seen.add(name);
                    const c = bundle[name];
                    if (!c || c.type !== 'chunk') return;
                    for (const f of c.viteMetadata?.importedCss ?? []) cssFiles.add(f);
                    for (const dep of c.imports) walk(dep);
                };
                walk(chunk.fileName);
                const css = [...cssFiles]
                    .map((f) => `<link rel="stylesheet" href="./${f}" />`)
                    .join('\n');
                const js = `<script type="module" src="./${chunk.fileName}"></script>`;

                this.emitFile({ type: 'asset', fileName: `${page}.html`, source: pageHtml(js, css) });
            }
        },

        /** Dev: serve `/<page>` and `/<page>.html` with the same shell. */
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const name = (req.url ?? '/').split('?')[0]!.replace(/^\//, '').replace(/\.html$/, '');
                if (!pages.includes(name)) return next();
                const html = pageHtml(`<script type="module" src="/${VIRTUAL}${name}"></script>`, '');
                void server.transformIndexHtml(req.url!, html).then((out) => {
                    res.setHeader('Content-Type', 'text/html');
                    res.end(out);
                });
            });
        },
    };
}

export default defineConfig(({ mode }) => {
    // `--mode e2e` rather than an env var, so no cross-env dependency is needed to set it on
    // Windows. The E2E build is the ONLY build that includes the harness pages.
    const includeHarnesses = mode === 'e2e';
    const pages = discoverPages(includeHarnesses);

    return {
        root: here,
        // RELATIVE asset urls. See the note above — absolute paths 404 under file:// and the
        // window hangs with no error.
        base: './',
        plugins: [react(), geniePages(pages)],
        build: {
            // Where main/tsconfig.json also emits, so `loadFile(__dirname/master.html)` finds
            // its page beside the compiled main process.
            outDir: path.join(here, '..', 'app'),
            emptyOutDir: false,
            rollupOptions: {
                input: Object.fromEntries(pages.map((p) => [p, `${VIRTUAL}${p}`])),
            },
        },
        server: { port: 8888, strictPort: true },
    };
});
