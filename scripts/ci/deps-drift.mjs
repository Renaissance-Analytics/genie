#!/usr/bin/env node
/**
 * THE FANCY + PRISM DRIFT WATCHER (Tynn #442; .github/workflows/deps-drift.yml).
 * Every @particle-academy/* package the lockfile pins, direct or nested, against npm's latest; and any known advisory on one
 * of them, or on anything under one. Drift WARNS (a table in the job summary). An advisory FAILS (exit 1).
 *
 *   node scripts/ci/deps-drift.mjs collect --lock package-lock.json --latest latest.json [--ghsa ghsa.json]
 *     asks npm for each package's latest version, and (with --ghsa, needs `gh` + GH_TOKEN) GitHub's advisory database
 *     for advisories that affect each pinned version. Network only; decides nothing.
 *   node scripts/ci/deps-drift.mjs report --package package.json --lock package-lock.json --latest latest.json
 *       --audit audit.json [--ghsa ghsa.json] [--summary file]
 *     audit.json is `npm audit --package-lock-only --json`. Pure: files in, annotations + markdown out, exit 0 or 1.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const SCOPE = '@particle-academy/';

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    return out;
}
const readJson = (f, fallback) => { if (!f) return fallback; try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };

/** Every @particle-academy package in the lockfile: { name, version, path, direct }. */
export function pinned(pkg, lock) {
    const direct = new Set(Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.optionalDependencies }));
    const out = [];
    for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
        const at = path.lastIndexOf('node_modules/');
        if (at < 0) continue;
        const name = path.slice(at + 'node_modules/'.length);
        if (!name.startsWith(SCOPE) || !entry?.version) continue;
        out.push({ name, version: entry.version, path, direct: direct.has(name) && at === 0 });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')); return m ? m.slice(1, 4).map(Number) : null; };

/** How far `have` is behind `latest`: "up to date", "N major|minor|patch", "ahead", or "unknown". */
export function behind(have, latest) {
    const a = parse(have); const b = parse(latest);
    if (!a || !b) return 'unknown';
    for (const [i, unit] of [[0, 'major'], [1, 'minor'], [2, 'patch']]) {
        if (b[i] > a[i]) return `${b[i] - a[i]} ${unit}`;
        if (b[i] < a[i]) return 'ahead';
    }
    return 'up to date';
}

/** The root advisories behind an npm audit entry, following `via` names through the report. */
function roots(vulns, name, seen = new Set()) {
    if (seen.has(name)) return [];
    seen.add(name);
    const out = [];
    for (const via of vulns[name]?.via ?? []) {
        if (typeof via === 'string') out.push(...roots(vulns, via, seen));
        else out.push({ package: via.name ?? name, title: via.title ?? '', url: via.url ?? '', severity: via.severity ?? vulns[name]?.severity ?? '' });
    }
    return out;
}

/** Advisories that reach a @particle-academy package: [{ pkg: "name@version", package, title, url, severity }]. */
export function advisories(pins, audit, ghsa) {
    const vulns = audit?.vulnerabilities ?? {};
    const version = (name) => pins.find((p) => p.name === name)?.version ?? '?';
    const found = new Map();
    const add = (pkg, a) => { const k = `${pkg}|${a.url || a.title}`; if (!found.has(k)) found.set(k, { pkg, ...a }); };
    for (const [name, v] of Object.entries(vulns)) {
        // npm marks the @particle-academy package itself as vulnerable when it, or something it depends on, is; a nested copy
        // shows up in `nodes` under its parent's path.
        const reached = new Set();
        if (name.startsWith(SCOPE)) reached.add(name);
        for (const node of v?.nodes ?? []) {
            const m = /node_modules\/(@particle-academy\/[^/]+)\/node_modules\//.exec(node);
            if (m) reached.add(m[1]);
        }
        for (const owner of reached) for (const a of roots(vulns, name)) add(`${owner}@${version(owner)}`, a);
    }
    for (const [key, list] of Object.entries(ghsa ?? {})) {
        for (const a of Array.isArray(list) ? list : []) add(key, { package: key.replace(/@[^@]*$/, ''), title: a.summary ?? '', url: a.html_url ?? a.ghsa_id ?? '', severity: a.severity ?? '' });
    }
    return [...found.values()];
}

const ghsaId = (url) => /GHSA-[\w-]+/.exec(url)?.[0] ?? url;
// Backslashes FIRST, then pipes, then newlines: an input "\|" must not turn into "\\|", an escaped backslash and a live pipe.
const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function report({ pkg, lock, latest, audit, ghsa }) {
    const pins = pinned(pkg, lock);
    const rows = pins.map((p) => ({ ...p, latest: latest?.[p.name] ?? '?', behind: behind(p.version, latest?.[p.name]) }));
    const found = advisories(pins, audit, ghsa);
    const drifted = rows.filter((r) => /^\d+ (major|minor|patch)$/.test(r.behind));
    const lines = [];
    const md = [];
    md.push('## Fancy + Prism drift', '');
    if (found.length) {
        md.push(`### ${found.length} advisory(ies) on @particle-academy packages`, '', '| package | via | severity | advisory |', '| --- | --- | --- | --- |');
        for (const a of found) {
            md.push(`| ${cell(a.pkg)} | ${cell(a.package)} | ${cell(a.severity)} | [${cell(ghsaId(a.url))}](${a.url}) ${cell(a.title)} |`);
            lines.push(`::error title=Advisory on ${a.pkg}::${a.pkg} via ${a.package}: ${ghsaId(a.url)} (${a.severity}) ${a.title}`.replace(/\r?\n/g, ' '));
        }
        md.push('');
    }
    md.push(`${drifted.length} of ${rows.length} behind npm latest.`, '', '| package | pinned | latest | behind | |', '| --- | --- | --- | --- | --- |');
    for (const r of rows) md.push(`| ${r.name} | ${r.version} | ${r.latest} | ${r.behind} | ${r.direct ? 'direct' : `nested: ${r.path}`} |`);
    md.push('');
    if (drifted.length) lines.push(`::warning title=Fancy + Prism drift::${drifted.length} of ${rows.length} @particle-academy packages behind npm latest: ${drifted.map((r) => `${r.name} ${r.version} -> ${r.latest}`).join(', ')}`);
    const unknown = rows.filter((r) => r.behind === 'unknown');
    if (unknown.length) lines.push(`::warning title=Fancy + Prism drift::no latest version for ${unknown.map((r) => r.name).join(', ')}`);
    return { markdown: md.join('\n'), annotations: lines, failed: found.length > 0 };
}

function collect(a) {
    const pins = pinned(null, readJson(a.lock, {}));
    const names = [...new Set(pins.map((p) => p.name))];
    const latest = {};
    for (const name of names) {
        try { latest[name] = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim(); }
        catch (e) { console.log(`::warning::npm view ${name} version failed: ${String(e?.message ?? e).split('\n')[0]}`); }
    }
    writeFileSync(a.latest, JSON.stringify(latest, null, 2));
    if (a.ghsa) {
        const ghsa = {};
        for (const key of [...new Set(pins.map((p) => `${p.name}@${p.version}`))]) {
            try {
                const out = execFileSync('gh', ['api', '-X', 'GET', 'advisories', '-f', 'ecosystem=npm', '-f', `affects=${key}`, '-f', 'per_page=100'], { encoding: 'utf8' });
                const list = JSON.parse(out);
                if (Array.isArray(list) && list.length) ghsa[key] = list.map((x) => ({ ghsa_id: x.ghsa_id, summary: x.summary, severity: x.severity, html_url: x.html_url }));
            } catch (e) { console.log(`::warning::GitHub advisory lookup for ${key} failed: ${String(e?.message ?? e).split('\n')[0]}`); }
        }
        writeFileSync(a.ghsa, JSON.stringify(ghsa, null, 2));
    }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'collect') collect(args(rest));
else if (cmd === 'report') {
    const a = args(rest);
    const r = report({ pkg: readJson(a.package, {}), lock: readJson(a.lock, {}), latest: readJson(a.latest, {}), audit: readJson(a.audit, {}), ghsa: readJson(a.ghsa, {}) });
    for (const l of r.annotations) console.log(l);
    if (a.summary) appendFileSync(a.summary, `${r.markdown}\n`);
    else console.log(r.markdown);
    process.exit(r.failed ? 1 : 0);
}
else if (cmd) { console.error(`deps-drift: unknown command ${cmd}`); process.exit(2); }
