import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VERSIONS,
    GENIE_POSTGRES_IMAGE,
    GENIE_POSTGRES_IMAGE_MAJOR,
    engineSpecFor,
} from '../services/catalog';
import { POSTGRES_EXTENSIONS } from '../services/extensions';

/**
 * THE PROMISE AND THE IMAGE, kept in one piece.
 *
 * The bug this image exists to end was not a broken line of code. Every piece
 * was individually correct: `extensions.ts` listed `postgis`, `manageService`
 * advertised it, `provision.ts` built valid SQL — and `CREATE EXTENSION postgis`
 * failed, because the IMAGE had never carried it and nothing anywhere connected
 * those two facts. A capability was promised in three places and delivered in
 * none.
 *
 * Three files now have to agree, and each one can be edited alone:
 *
 *   - `services/extensions.ts` — what a workspace may ASK for.
 *   - `postgres-image/Dockerfile` — what EXISTS.
 *   - `.github/workflows/postgres-image.yml` — what gets BUILT and PROVEN
 *     before publishing, for which Postgres majors.
 *
 * This test is the reason the next person to add an extension to the whitelist
 * finds out that the image build has to learn about it too — in seconds, in the
 * fast CI lane, rather than from a workspace whose `CREATE EXTENSION` failed
 * after a tag had already gone out.
 *
 * It reads the workflow as TEXT rather than parsed YAML: the repository has no
 * YAML parser in `main`'s dependency tree, and the strings being checked are
 * literal scalars, so a regex over the file is honest here in a way it would
 * not be for structure.
 */

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, '.github/workflows/postgres-image.yml');
const DOCKERFILE = path.join(ROOT, 'main/dev-server/postgres-image/Dockerfile');

/**
 * Read with line endings NORMALISED.
 *
 * Not tidiness: every regex below anchors on `$`, and `$` in JavaScript's
 * multiline mode matches immediately before `\n` — so a lone `\r` sitting there
 * defeats it. This repository is checked out CRLF on Windows and LF on the
 * Linux CI runners, which is the worst possible shape for a guard: it would
 * pass on CI, fail on a contributor's machine, and the failure would say
 * nothing about newlines. Normalise once, at the only place the bytes enter.
 */
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const workflow = () => read(WORKFLOW);
const dockerfile = () => read(DOCKERFILE);

/** The value of one `KEY: value` line in the workflow's top-level `env:`. */
function workflowEnv(key: string): string | null {
    const m = new RegExp(`^  ${key}: *'?([^'\\n]+?)'? *$`, 'm').exec(workflow());
    return m ? m[1]!.trim() : null;
}

/**
 * The `pg: ['17', …]` matrix list under a named job.
 *
 * The job's body is sliced by finding the NEXT two-space-indented key rather
 * than by one regex spanning to end-of-input: `\Z` is not JavaScript, and the
 * naive lookahead reads as a literal `Z`, which matches nothing after the LAST
 * job in the file — quietly excusing `manifest` from every assertion below.
 */
function matrixVersions(job: 'build' | 'manifest'): string[] | null {
    const text = workflow();
    const start = new RegExp(`^  ${job}:\\s*$`, 'm').exec(text);
    if (!start) return null;
    const rest = text.slice(start.index + start[0].length);
    const next = /^ {2}[A-Za-z][\w-]*:/m.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest;
    const m = /^ +pg: \[([^\]]+)\]/m.exec(body);
    if (!m) return null;
    return m[1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

describe('the Genie Postgres image', () => {
    it('is what the catalog points every Postgres version at', () => {
        const postgres = engineSpecFor('postgres');
        for (const version of postgres.versions) {
            // `pg<postgres major>-<image major>`: two majors because two things
            // move independently — the user's Postgres choice, and Genie's own
            // image. Never `:latest`.
            expect(postgres.image(version)).toBe(
                `${GENIE_POSTGRES_IMAGE}:pg${version}-${GENIE_POSTGRES_IMAGE_MAJOR}`,
            );
        }
    });

    it('is named identically in the catalog and in the workflow that publishes it', () => {
        // A rename in one place and not the other publishes an image nothing
        // pulls, and the symptom is `image-missing` on a user's desktop with a
        // registry that has the image sitting right there under another name.
        expect(workflowEnv('IMAGE')).toBe(GENIE_POSTGRES_IMAGE);
    });

    it('publishes from the directory the Dockerfile actually lives in', () => {
        const context = workflowEnv('CONTEXT');
        expect(context).toBeTruthy();
        expect(fs.existsSync(path.join(ROOT, context!, 'Dockerfile'))).toBe(true);
        expect(path.resolve(ROOT, context!, 'Dockerfile')).toBe(path.resolve(DOCKERFILE));
    });

    it('builds EVERY Postgres major the catalog offers', () => {
        // A major in `versions` with no build is a major `manageService` offers
        // and nobody can start: the pull 404s at the registry, which is a
        // failure no unit test can see and that only a user hits.
        const offered = [...engineSpecFor('postgres').versions];
        expect(matrixVersions('build')).toEqual(offered);
        // …and stitches a manifest list for every one of them, or the arm64
        // half is built and then stranded unpublished.
        expect(matrixVersions('manifest')).toEqual(offered);
    });

    it('smoke-tests every extension the whitelist lets a workspace ask for', () => {
        // THE assertion this file exists for. `extensions.ts` is the promise;
        // the workflow's EXTENSIONS list is what gets proven against a running
        // server before anything is published. Adding a name to the whitelist
        // without adding it here would restore the exact bug — an extension
        // Genie offers and the image does not carry.
        const smoked = workflowEnv('EXTENSIONS')?.split(/\s+/).filter(Boolean);
        expect(smoked).toEqual([...POSTGRES_EXTENSIONS]);
    });

    it('defaults its build to the Postgres major the catalog defaults to', () => {
        // So `docker build main/dev-server/postgres-image` with no build-arg —
        // what a human reaching for it will type — produces the engine a
        // workspace gets when it names no version.
        const arg = /^ARG PG_MAJOR=(.+)$/m.exec(dockerfile());
        expect(arg?.[1]?.trim()).toBe(DEFAULT_VERSIONS.postgres);
    });

    it('builds on the image Genie pinned before, so the drop-in claim is structural', () => {
        // `catalog.ts` promises `psql`/`pg_isready`, the PGDATA layout and the
        // admin env are unchanged. That promise is kept by INHERITANCE — the
        // base is what Genie already ran — not by re-implementation. A base
        // change is therefore a real decision, and this is where it gets made
        // deliberately instead of in passing.
        expect(dockerfile()).toMatch(/^FROM pgvector\/pgvector:pg\$\{PG_MAJOR\}$/m);
    });
});
