import { describe, expect, it } from 'vitest';
import {
    AGENT_CLI_CATALOG,
    AGENT_CLI_IDS,
    agentCliDef,
    agentCliForProvider,
    agentCliSpecs,
    installableAgentClis,
    npmPackagesByTool,
} from '../agent-cli-catalog';
import { PROVIDER_IDS, TUI_REGISTRY } from '../registry';

/**
 * The ONE table of agent CLIs Genie can detect and install.
 *
 * ## The fault this closes
 *
 * The Toolchain page's Agent CLIs tab derived its membership from a hardcoded
 * `['claude-code', 'codex']` in the renderer. It read as "what agent CLIs does
 * this machine have" and actually meant "the two names we wrote down" — so a
 * provider the registry already carried (Genie TUI, Kiwi Code) could never
 * appear there, and the owner found out only when a terminal died with
 * `bash: genie: command not found`.
 *
 * Two names for the same fact, one of them unenforced, is the same shape
 * `registry.ts` was written to end. So the toolchain's agent-CLI set derives
 * from THIS table, and this table is required to cover every provider that
 * names a fixed binary — a claim the type system makes for the compiler and
 * these tests make for a human reading the failure.
 */

describe('the catalog covers every provider that names a binary', () => {
    it('has an entry for each provider with a fixed defaultCommand', () => {
        const uncovered = PROVIDER_IDS.filter(
            (id) => TUI_REGISTRY[id].defaultCommand !== '' && !agentCliForProvider(id),
        );
        expect(uncovered).toEqual([]);
    });

    it('lists the Genie TUI, the provider whose absence started this', () => {
        const genie = agentCliForProvider('genie');
        expect(genie).toBeDefined();
        expect(genie!.bin).toBe('genie');
    });

    it('claims no provider that has no binary to claim — custom is the owner’s own command', () => {
        expect(agentCliForProvider('custom')).toBeUndefined();
    });

    it('never disagrees with the registry about the binary — the `genie-tui` bug, one layer on', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (!entry.provider) continue;
            expect(entry.bin).toBe(TUI_REGISTRY[entry.provider].defaultCommand);
        }
    });

    it('never disagrees with the registry about the NAME either', () => {
        // The agent picker and the Toolchain page name the same product. Two
        // spellings of it is how a person ends up unsure whether "Claude Code"
        // in Settings is the thing they picked in the rail.
        for (const entry of AGENT_CLI_CATALOG) {
            if (!entry.provider) continue;
            expect(entry.label, entry.id).toBe(TUI_REGISTRY[entry.provider].label);
        }
    });
});

describe('every entry is a usable detection recipe', () => {
    it('gives each tool a unique id and a unique binary', () => {
        expect(new Set(AGENT_CLI_IDS).size).toBe(AGENT_CLI_IDS.length);
        const bins = AGENT_CLI_CATALOG.map((e) => e.bin);
        expect(new Set(bins).size).toBe(bins.length);
    });

    it('can ask every tool for a version', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            expect(entry.versionArgv.length).toBeGreaterThan(0);
        }
    });

    it('produces a probe spec per tool, keyed by id and spawning the BIN', () => {
        const specs = agentCliSpecs();
        expect(Object.keys(specs).sort()).toEqual([...AGENT_CLI_IDS].sort());
        expect(specs['claude-code']!.bin).toBe('claude');
        expect(specs['claude-code']!.name).toBe('claude-code');
    });
});

describe('a gap is stated, never hidden', () => {
    it('makes an uninstallable tool SAY why, so a row can show the gap instead of a dead button', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.install) continue;
            expect(entry.installGap, `${entry.id} has no installer and no reason`).toBeTruthy();
        }
    });

    it('points every tool Genie cannot install at somewhere the person can', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.install) continue;
            // `kiwi` is the one exception, and it is the honest one: there is no
            // documentation to link because no such product could be found.
            if (entry.id === 'kiwi') continue;
            expect(entry.docsUrl, `${entry.id} has no docs URL`).toMatch(/^https:\/\//);
        }
    });

    it('never links anywhere but https', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.docsUrl === undefined) continue;
            expect(entry.docsUrl, entry.id).toMatch(/^https:\/\//);
        }
    });

    it('separates what Genie CAN install from what it merely knows about', () => {
        const installable = installableAgentClis().map((e) => e.id);
        expect(installable).toContain('claude-code');
        expect(installable).toContain('codex');
        // Genie's own TUI is NOT installable, and that reversal is the point.
        // It was listed as installable on the strength of a `npm install
        // github:…` run — LOCAL, which is not the command the product runs.
        // `npm install -g` of the same git spec fails every time (see the
        // git-spec suite below), so a button here would be one that always
        // fails, which the catalog exists to refuse.
        expect(installable).not.toContain('genie');
        expect(agentCliDef('genie')?.installGap).toBeTruthy();
        // The negative case still needs a real one, or this only proves that
        // everything is installable. Aider is PyPI-only and Genie has no Python
        // installer, so it is a listed gap rather than a silent absence.
        expect(installable).not.toContain('aider');
    });
});

describe('the npm packages the installer and the update check share', () => {
    it('keeps the two shipping tools exactly as they are — a rename here is a silent breakage', () => {
        expect(npmPackagesByTool()['claude-code']).toBe('@anthropic-ai/claude-code');
        expect(npmPackagesByTool()['codex']).toBe('@openai/codex');
    });

    it('maps every npm-installable tool, and only those', () => {
        const mapped = Object.keys(npmPackagesByTool()).sort();
        const expected = AGENT_CLI_CATALOG.filter((e) => e.install?.manager === 'npm')
            .map((e) => e.id)
            .sort();
        expect(mapped).toEqual(expected);
    });

    it('names a scoped package exactly once per tool', () => {
        const packages = Object.values(npmPackagesByTool());
        expect(new Set(packages).size).toBe(packages.length);
    });
});

describe('the list the owner asked to be expanded', () => {
    it('is no longer two', () => {
        expect(AGENT_CLI_IDS.length).toBeGreaterThan(2);
    });

    it('carries the agents whose CLIs were verified against their own package manifests', () => {
        for (const id of ['gemini-cli', 'opencode', 'copilot-cli', 'crush', 'amp'] as const) {
            expect(agentCliDef(id)?.install?.manager).toBe('npm');
        }
    });
});

/**
 * The install spec has to be a spec npm can actually run — and a GIT spec is not
 * one, under `npm install -g`.
 *
 * The Genie TUI shipped with `install: {manager: 'npm', package:
 * 'github:Renaissance-Analytics/genie-tui'}` and the Install button failed for
 * every user who pressed it:
 *
 *     > @genie/tui@0.0.0 build
 *     > tsc -p tsconfig.build.json
 *     'tsc' is not recognized as an internal or external command
 *
 * WHY, established by running both commands rather than reading either repo:
 *
 *   - npm prepares a git dependency by cloning it and shelling out to a nested
 *     `npm install --force … --include=dev …` inside the clone (pacote's
 *     `fetcher.js`), then running the package's `prepare`.
 *   - `npm install -g --prefix X` exports `npm_config_global=true` and
 *     `npm_config_prefix=X` to that nested process, so the nested install is
 *     ALSO global — the clone's dependencies land in `X/node_modules/@genie/tui/
 *     node_modules/…` instead of in the clone. Observed on disk, and for
 *     `@mastra/core` — a plain `dependencies` entry — as well as the dev ones.
 *   - The clone therefore has no `node_modules/.bin`, so `prepare` →
 *     `npm run build` → `tsc` cannot resolve, and the whole install fails.
 *
 * The catalog comment claimed this installer had been checked by RUNNING it. It
 * had — as `npm install github:Renaissance-Analytics/genie-tui`, LOCAL, with no
 * `-g`. That command succeeds and answers a different question from the one the
 * product asks. The variable was isolated by running all three:
 *
 *     npm install                github:…/genie-tui   -> exit 0, .bin/genie
 *     npm install --prefix X     github:…/genie-tui   -> exit 0, .bin/genie
 *     npm install -g --prefix X  github:…/genie-tui   -> FAILS, 'tsc' not found
 *
 * so it is `-g` that breaks it, not the prefix. A verification that runs a
 * weaker command than the product does is the fault family this repository
 * keeps finding; this is the cleanest instance of it.
 *
 * Moving `typescript` into `dependencies` does NOT fix it — nothing at all lands
 * in the clone, dev or not. The fix belongs in the package: ship a prebuilt
 * `dist` (no `prepare` to run), or install from a packed TARBALL rather than a
 * git spec — npm never prepares a tarball, because a tarball is already built.
 * Until one of those exists the row states the gap, which is what `install: null`
 * is for.
 *
 * The rule below is therefore about GIT SPECS and nothing wider. Its first
 * version also rejected `https?:`, which forbade the tarball remedy this very
 * paragraph recommends — see {@link isGitSpec}.
 */

/**
 * Is this npm spec a GIT spec — the one form `npm install -g` cannot prepare?
 *
 * Every form npm resolves through its git fetcher, and nothing else:
 *
 *   - the hosted shorthands (`github:`, `gitlab:`, `bitbucket:`, `gist:`),
 *   - the explicit schemes (`git:`, `git+https:`, `git+ssh:`, `git+file:`),
 *   - any URL whose path ends `.git`, with or without a `#committish` — a git
 *     spec wearing a URL,
 *   - and BARE `owner/repo`, which npm treats as GitHub. It is the form most
 *     likely to be typed by someone reaching for a repository, and the one a
 *     scheme check misses entirely. A scoped registry name (`@scope/name`) also
 *     contains a slash and is NOT this.
 *
 * A TARBALL URL is deliberately NOT a git spec, and that exemption is the point
 * of this function existing at all. npm prepares a git CLONE; it never prepares
 * a packed tarball, because a tarball is already built — so
 * `https://…/releases/latest/download/genie-tui.tgz` is exactly the remedy the
 * comment above recommends, and it installs globally without complaint.
 *
 * The first version of this rule read `/^(github:|…|https?:)/` and therefore
 * forbade the fix it names three paragraphs up. The evidence established "no GIT
 * spec"; it was widened to "no URL" with no evidence for the second half, and an
 * invariant that contradicts its own stated remedy is worse than none — the next
 * person reads the comment, does what it says, and gets a red test that appears
 * to tell them they are wrong.
 */
function isGitSpec(pkg: string): boolean {
    if (/^(github:|gitlab:|bitbucket:|gist:|git:|git\+)/.test(pkg)) return true;
    if (/\.git(#[^#]*)?$/.test(pkg)) return true;
    // Bare `owner/repo` — GitHub shorthand. `@scope/name` is a registry name.
    return !pkg.startsWith('@') && !pkg.includes(':') && pkg.includes('/');
}

describe('an npm install spec names a REGISTRY package, never a git spec', () => {
    it('has no git spec anywhere — npm cannot prepare one under `install -g`', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.install?.manager !== 'npm') continue;
            expect(isGitSpec(entry.install.package), `${entry.id} installs by git spec`).toBe(
                false,
            );
        }
    });

    it('recognises every git form npm does', () => {
        for (const spec of [
            'github:Renaissance-Analytics/genie-tui',
            'gitlab:owner/repo',
            'bitbucket:owner/repo',
            'gist:0a1b2c3d',
            'git://github.com/owner/repo',
            'git+https://github.com/owner/repo.git',
            'git+ssh://git@github.com/owner/repo.git',
            'https://github.com/owner/repo.git',
            'https://github.com/owner/repo.git#v1.2.3',
            'Renaissance-Analytics/genie-tui',
        ]) {
            expect(isGitSpec(spec), spec).toBe(true);
        }
    });

    /**
     * The exemption, PINNED. An exemption that exists only as the absence of a
     * rule is one somebody re-adds — which is how the `https?:` in the first
     * version of this got there.
     */
    it('does NOT flag a packed tarball URL — the remedy this rule exists to allow', () => {
        for (const spec of [
            'https://github.com/Renaissance-Analytics/genie-tui/releases/latest/download/genie-tui.tgz',
            'https://github.com/Renaissance-Analytics/genie-tui/releases/download/v0.1.0/genie-tui-0.1.0.tgz',
            'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        ]) {
            expect(isGitSpec(spec), spec).toBe(false);
        }
    });

    it('does NOT flag the registry names the catalog actually uses', () => {
        for (const spec of ['@anthropic-ai/claude-code', '@openai/codex', 'cline', 'opencode-ai']) {
            expect(isGitSpec(spec), spec).toBe(false);
        }
    });

    it('still has npm specs to check — the loop above passes on an empty catalog too', () => {
        const npmSpecs = AGENT_CLI_CATALOG.filter((e) => e.install?.manager === 'npm');
        expect(npmSpecs.length).toBeGreaterThan(10);
    });
});
