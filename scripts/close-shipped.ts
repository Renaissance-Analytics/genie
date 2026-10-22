/**
 * After a release is published (.github/workflows/release-published.yml, on the owner publishing the draft): every issue a commit since the previous release
 * says it fixes or closes (src/core/shipped-issues.ts) is told "Shipped in <tag>" — once, by marker — and closed if
 * still open. A pull request's number is skipped.
 *
 * NEVER FAILS THE RELEASE: the release is already published when this runs; anything that goes wrong is a warning
 * in the log and the exit is 0.
 *
 * Usage: npx tsx scripts/close-shipped.ts <tag>   (GH_TOKEN and GITHUB_REPOSITORY in the environment)
 */
import { execFileSync } from 'node:child_process';
import { previousReleaseTag, SHIPPED_MARKER, shippedComment, shippedIssues } from '../src/core/shipped-issues.js';

const tag = process.argv[2] ?? '';
const repo = process.env['GITHUB_REPOSITORY'] ?? '';

function git(...args: string[]): string {
    return execFileSync('git', args, { encoding: 'utf8' });
}

function gh(...args: string[]): string {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main(): void {
    if (!tag || !repo) {
        console.log('::warning::close-shipped needs a tag and GITHUB_REPOSITORY; nothing done');
        return;
    }
    const previous = previousReleaseTag(git('tag', '--sort=-creatordate').split('\n').map((t) => t.trim()).filter(Boolean), tag);
    if (previous === null) {
        console.log(`no release before ${tag}; nothing to close`);
        return;
    }
    const messages = git('log', '--format=%B%x00', `${previous}..${tag}`).split('\0');
    const issues = shippedIssues(messages, repo);
    console.log(`${tag} (since ${previous}) ships: ${issues.length === 0 ? 'no named fixes' : issues.map((n) => `#${n}`).join(' ')}`);

    for (const n of issues) {
        try {
            const issue = JSON.parse(gh('api', `repos/${repo}/issues/${n}`)) as { state: string; pull_request?: unknown };
            if (issue.pull_request !== undefined) continue; // a pull request, not an issue
            const comments = gh('api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[].body');
            if (!comments.includes(SHIPPED_MARKER(tag))) {
                gh('api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '-f', `body=${shippedComment(tag, repo)}`);
            }
            if (issue.state === 'open') {
                gh('api', '-X', 'PATCH', `repos/${repo}/issues/${n}`, '-f', 'state=closed', '-f', 'state_reason=completed');
            }
            console.log(`#${n}: shipped in ${tag}${issue.state === 'open' ? ', closed' : ''}`);
        } catch (error) {
            console.log(`::warning::#${n}: could not mark it shipped: ${(error as Error).message.split('\n')[0]}`);
        }
    }
}

try {
    main();
} catch (error) {
    console.log(`::warning::close-shipped: ${(error as Error).message.split('\n')[0]}`);
}
