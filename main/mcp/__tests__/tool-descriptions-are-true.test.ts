import { describe, expect, it } from 'vitest';
import { CORE_TOOLS } from '../protocol';

/**
 * **A tool asserting a fact about the environment it creates must be the thing
 * that makes the fact true** — genie#540's principle, and the reason genie#538 and
 * genie#539 were expensive to find. An agent that believes its tools is currently
 * worse off than one that verifies everything, which is exactly the token burn the
 * epic is about.
 *
 * Two descriptions asserted things this tree does not do. Each is pinned here so
 * the sentence cannot come back without the behaviour coming back with it.
 */

const tool = (name: string): { name: string; description: string } => {
    const found = (CORE_TOOLS as ReadonlyArray<{ name: string; description: string }>).find(
        (t) => t.name === name,
    );
    expect(found, `${name} must be advertised`).toBeTruthy();
    return found!;
};

describe('manageSite says what a bare `create` actually does (genie#538)', () => {
    it('does not promise `php artisan serve` for a PHP/Laravel repo', () => {
        // It said: "a bare `create {name}` detects the stack and runs its OWN dev
        // server — PHP/Laravel → `php artisan serve`". That stopped being true at
        // genie#274: `detectPhpServe` runs first and a Laravel repo is SERVED, from
        // `public/` over FastCGI, with no process of Genie's at all.
        //
        // It is not a stale nicety. It is the sentence that tells an agent the
        // single-threaded dev server is the normal outcome for PHP — so the agent
        // that hit genie#538 had no reason to think anything had gone wrong.
        const description = tool('manageSite').description;

        expect(description).not.toMatch(/PHP\/Laravel\s*→\s*`?php artisan serve/i);
    });

    it('names FastCGI as what a PHP repo gets, in the same breath as the other stacks', () => {
        // Not merely "the false claim is gone" — a negative assertion passes against
        // a description that says nothing about PHP at all, and this one already says
        // "FastCGI" elsewhere (about `logs`), so a bare search for the word would be
        // vacuous. It has to appear where the stack defaults are listed, because a
        // PHP site being SERVED rather than RUN is what an agent needs to know before
        // it reaches for `command` or `hostPort`.
        const description = tool('manageSite').description;

        expect(description).toMatch(/PHP\/Laravel\s*→[^;]*FastCGI/i);
    });
});

describe('manageService says what it actually injects into (genie#539)', () => {
    it('does not claim service env reaches BUILD steps — nothing runs them', () => {
        // It said `envKeys` are injected "into this workspace's hosted sites
        // (`manageSite`), and into their BUILD steps too". `runSiteBuild` has no
        // production caller in this tree — `manageSite`'s own advisory already tells
        // callers "`build` steps are recorded but NOT run (genie#191)" — so the two
        // tools were telling agents opposite things about the same field.
        const description = tool('manageService').description;

        expect(description).not.toMatch(/BUILD steps too/i);
    });

    it('still promises the thing that IS now true — no `.env` edit for a served app', () => {
        // The promise itself is the right one and genie#539 makes it true for the
        // FastCGI path. Deleting it to make the file honest would have been the
        // cheap way out; the sentence stays, and the behaviour is what moved.
        const description = tool('manageService').description;

        expect(description).toMatch(/needs no `?\.env`? edit/i);
    });
});
