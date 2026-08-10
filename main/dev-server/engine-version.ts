import fs from 'node:fs';
import path from 'node:path';

/**
 * Engine-version selection (goal item 4), the INTERIM approach (owner's call):
 * DETECT the language runtime version a repo declares, VALIDATE it against the
 * version installed on the HOST, and WARN on a mismatch — rather than silently
 * switching a host engine (php/node/go run on Genie's PATH, not in a container).
 * A clear "this repo wants node 22, your host has 20" is the actionable thing; a
 * full multi-version host toolchain is a separate subsystem, not this.
 *
 * Pure parsers here (they take file CONTENTS, so every rule is unit-testable), a
 * thin fs reader, and a deliberately loose MAJOR-version compare — enough to flag
 * "wrong major", which is what actually breaks, without pretending to be a semver
 * range solver.
 */

/** The runtime versions a repo declares, by engine. Values are the raw declared
 *  strings (a bare version, or a range like `^8.2`), interpreted by the compare. */
export interface DeclaredEngines {
    node?: string;
    php?: string;
    go?: string;
    python?: string;
}

/** `.nvmrc` / `.node-version`: a bare version, maybe with a leading `v`. */
export function parseNvmrc(content: string): string | undefined {
    const v = content.trim().replace(/^v/, '');
    return v || undefined;
}

/** `.tool-versions` (asdf/mise): `tool version` per line, `#` comments ignored. */
export function parseToolVersions(content: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [tool, version] = trimmed.split(/\s+/);
        if (tool && version) out[tool] = version;
    }
    return out;
}

/** `go.mod`: the `go <version>` directive. */
export function parseGoMod(content: string): string | undefined {
    return /^\s*go\s+(\d[\w.\-]*)/m.exec(content)?.[1];
}

/** `composer.json`: the pinned platform php, else the `require.php` constraint. */
export function parseComposerPhp(content: string): string | undefined {
    try {
        const c = JSON.parse(content) as {
            config?: { platform?: { php?: unknown } };
            require?: { php?: unknown };
        };
        const platform = c.config?.platform?.php;
        if (typeof platform === 'string' && platform) return platform;
        const req = c.require?.php;
        if (typeof req === 'string' && req) return req;
    } catch {
        /* an unparseable composer.json declares nothing we can read */
    }
    return undefined;
}

function readFileOrEmpty(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

/** Read the versions a repo declares across the common sources. Never throws; an
 *  engine with no declaration is simply absent. */
export function detectDeclaredEngines(repoDir: string): DeclaredEngines {
    const out: DeclaredEngines = {};
    const tool = parseToolVersions(readFileOrEmpty(path.join(repoDir, '.tool-versions')));

    // node: .nvmrc / .node-version > package.json engines.node > .tool-versions
    const nvmrc =
        parseNvmrc(readFileOrEmpty(path.join(repoDir, '.nvmrc'))) ??
        parseNvmrc(readFileOrEmpty(path.join(repoDir, '.node-version')));
    let pkgNode: string | undefined;
    try {
        const pkg = JSON.parse(readFileOrEmpty(path.join(repoDir, 'package.json'))) as {
            engines?: { node?: unknown };
        };
        if (typeof pkg.engines?.node === 'string') pkgNode = pkg.engines.node;
    } catch {
        /* no / unparseable package.json */
    }
    const node = nvmrc ?? pkgNode ?? tool.nodejs;
    if (node) out.node = node;

    // php: composer platform/require > .tool-versions
    const php = parseComposerPhp(readFileOrEmpty(path.join(repoDir, 'composer.json'))) ?? tool.php;
    if (php) out.php = php;

    // go: go.mod > .tool-versions ; python: .python-version > .tool-versions
    const go = parseGoMod(readFileOrEmpty(path.join(repoDir, 'go.mod'))) ?? tool.golang ?? tool.go;
    if (go) out.go = go;
    const python =
        parseNvmrc(readFileOrEmpty(path.join(repoDir, '.python-version'))) ?? tool.python;
    if (python) out.python = python;

    return out;
}

/** The host engine a site's stack runs on, or null for a stack with no host
 *  runtime to version-check (static assets, or rust which we do not probe). */
export function stackToEngine(stack?: string): keyof DeclaredEngines | null {
    if (stack === 'php' || stack === 'node' || stack === 'go' || stack === 'python') return stack;
    return null;
}

/**
 * How to ask the HOST for an engine's installed version, and how to read the
 * answer. Pure (argv + a parser), so the version extraction is unit-tested and the
 * caller supplies only the spawn. `php -r 'echo PHP_VERSION;'` gives a clean
 * string; `go version` and `node`/`python --version` need the number pulled out.
 */
export function hostEngineProbe(engine: keyof DeclaredEngines): {
    command: string[];
    parse: (output: string) => string | null;
} {
    switch (engine) {
        case 'node':
            return { command: ['node', '--version'], parse: (o) => /v?(\d[\w.-]*)/.exec(o.trim())?.[1] ?? null };
        case 'php':
            return { command: ['php', '-r', 'echo PHP_VERSION;'], parse: (o) => /(\d[\w.-]*)/.exec(o.trim())?.[1] ?? null };
        case 'go':
            return { command: ['go', 'version'], parse: (o) => /go(\d[\w.-]*)/.exec(o)?.[1] ?? null };
        case 'python':
            return { command: ['python', '--version'], parse: (o) => /(\d[\w.-]*)/.exec(o)?.[1] ?? null };
    }
}

/** The MAJOR version from a bare version or a range (`^8.2` → 8, `>=18` → 18),
 *  or null when nothing numeric leads it (`stable`, `latest`). */
export function engineMajor(version: string): number | null {
    const m = /(\d+)/.exec(version.trim().replace(/^v/, ''));
    return m ? Number(m[1]) : null;
}

/**
 * A one-line warning when the host's installed engine version does not match what
 * the repo declares — or null when it matches, nothing was declared, or the
 * declaration is not a comparable version. `installed` is null when the engine is
 * not on the host / could not be probed (which is itself worth flagging).
 */
export function describeEngineMismatch(
    engine: string,
    declared: string | undefined,
    installed: string | null,
): string | null {
    if (!declared) return null;
    const want = engineMajor(declared);
    if (want === null) return null; // e.g. `stable` — nothing to compare
    if (installed === null) {
        return (
            `this repo declares ${engine} ${declared}, but ${engine} is not on Genie's PATH — ` +
            `install it (or a version manager) so the host-native site runs on the right runtime`
        );
    }
    const have = engineMajor(installed);
    if (have === null || have === want) return null;
    return (
        `this repo declares ${engine} ${declared} but Genie's host has ${engine} ${installed} — ` +
        `a host-native site runs on the host runtime, so install ${engine} ${want}.x (or a version ` +
        `manager) to match`
    );
}
