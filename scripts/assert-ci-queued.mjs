// @ts-check
/**
 * assert-ci-queued.mjs — fail loudly when a pull request's head commit has no CI.
 *
 * Runs from `.github/workflows/pr-ci-queued.yml` on `pull_request_target`, which
 * is the whole point: `pull_request_target` evaluates the BASE branch and needs
 * no merge ref, so it still fires on exactly the pull requests where every
 * `pull_request` workflow silently does not (genie#574 — see
 * `ci-queued-verdict.mjs` for the full account).
 *
 * SAFETY: this must never check out or execute the submitted code. It reads two
 * API endpoints and looks at names. The workflow checks out the base branch (the
 * default under `pull_request_target`) purely to get this file.
 *
 * No dependencies — Node 22's global `fetch`, so the job needs no `npm ci` and
 * finishes in seconds.
 */

import { pathToFileURL } from 'node:url';

import { ciQueuedVerdict, REQUIRED_CHECKS } from './ci-queued-verdict.mjs';

export { REQUIRED_CHECKS };

/**
 * Poll until the verdict settles, or the budget runs out.
 *
 * `waiting` is the only state that costs another read; `satisfied`, `blocked`
 * and `skipped` are all final, so a conflicted PR is reported on the first read
 * rather than after three minutes of sleeping.
 *
 * @param {{
 *   observe: () => Promise<{ mergeable: boolean|null, mergeableState: string, checkNames: string[], fromFork: boolean }>,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   budgetMs: number,
 *   intervalMs: number,
 *   onPoll?: (v: ReturnType<typeof ciQueuedVerdict>, waitedMs: number) => void,
 * }} deps
 */
export async function awaitCiQueued({ observe, sleep, now, budgetMs, intervalMs, onPoll }) {
    const started = now();
    // Deliberately unbounded on iterations and bounded on TIME: the exit
    // condition is the clock the caller controls, so a slow API cannot turn this
    // into an infinite loop, and a fast one cannot exit early.
    for (;;) {
        const snapshot = await observe();
        const waitedMs = now() - started;
        const verdict = ciQueuedVerdict({ ...snapshot, waitedMs, budgetMs });
        if (onPoll) onPoll(verdict, waitedMs);
        if (verdict.state !== 'waiting') return verdict;
        await sleep(intervalMs);
    }
}

/* c8 ignore start — everything below is the GitHub Actions wiring. */

/** @param {string} path */
async function api(path, token) {
    const res = await fetch(`https://api.github.com${path}`, {
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            'user-agent': 'genie-ci-queued-guard',
        },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return res.json();
}

async function main() {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = process.env.PR_NUMBER;
    const headSha = process.env.PR_HEAD_SHA;
    if (!token || !repo || !prNumber || !headSha) {
        throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and PR_HEAD_SHA are required');
    }

    const budgetMs = Number(process.env.CI_QUEUED_BUDGET_MS || 180_000);
    const intervalMs = Number(process.env.CI_QUEUED_INTERVAL_MS || 15_000);

    const observe = async () => {
        const pr = await api(`/repos/${repo}/pulls/${prNumber}`, token);
        const checks = await api(
            `/repos/${repo}/commits/${headSha}/check-runs?per_page=100`,
            token,
        );
        return {
            mergeable: pr.mergeable ?? null,
            mergeableState: pr.mergeable_state ?? 'unknown',
            checkNames: (checks.check_runs || []).map((/** @type {any} */ c) => c.name),
            fromFork: (pr.head?.repo?.full_name ?? null) !== (pr.base?.repo?.full_name ?? null),
        };
    };

    const verdict = await awaitCiQueued({
        observe,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        budgetMs,
        intervalMs,
        onPoll: (v, waited) =>
            console.log(`[${Math.round(waited / 1000)}s] ${v.state} — ${v.summary}`),
    });

    // A step summary, so the answer is on the PR's Checks tab without anyone
    // opening a log. This check exists because a green tick was misread; its own
    // output must not need decoding.
    const icon = { satisfied: '✅', skipped: '⏭️', blocked: '❌' }[verdict.state] ?? '❓';
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(
            summaryFile,
            `## ${icon} ${verdict.summary}\n\n${verdict.detail}\n\n` +
                `<sub>head \`${headSha.slice(0, 8)}\` · required: ${REQUIRED_CHECKS.join(', ')}</sub>\n`,
        );
    }

    if (verdict.state === 'blocked') {
        // `::error::` puts it on the PR conversation as an annotation too.
        console.log(`::error title=${verdict.summary}::${verdict.detail.replace(/\n/g, '%0A')}`);
        console.error(`\n${verdict.summary}\n\n${verdict.detail}\n`);
        process.exitCode = 1;
        return;
    }
    console.log(`${icon} ${verdict.summary}`);
}

// Only run when invoked as a script — `pathToFileURL` rather than string
// surgery, so this is correct on Windows too. Importing the module (which the
// test does) must never fire the GitHub calls.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
/* c8 ignore stop */
