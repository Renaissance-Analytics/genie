import { resolve, join } from 'node:path';

/**
 * May prism's session-store probe be trusted on THIS installation?
 *
 * ## What the probe is for
 *
 * prism-acp 0.4.0 added `probeSession`, which turns a `session/load` for a session that does not
 * exist into an early, named refusal instead of an agent that comes up "resumed" and dies on its
 * first prompt. Genie asked for exactly that, because the late failure is indistinguishable from
 * any other and silently loses a conversation.
 *
 * ## Why it is not wired unconditionally
 *
 * `probeSessionStore` reads `(home ?? homedir()) + '/.claude/projects'` and **does not look at
 * `CLAUDE_CONFIG_DIR`**. The claude CLI does: it resolves `CLAUDE_CONFIG_DIR ?? ~/.claude`, which
 * is why `main/acp/agent-spec.ts` forwards that variable deliberately — the stored subscription
 * credential lives there.
 *
 * So on an installation with `CLAUDE_CONFIG_DIR` pointing somewhere else, the probe reads a
 * directory the CLI does not use, finds nothing, and answers `absent` for a conversation that
 * exists. That refuses a resume which WOULD have worked — and prism's own note says that is the
 * worse failure of the two, which is why `indeterminate` exists at all.
 *
 * The safe direction is therefore to omit the probe when its assumption does not hold. Omitting
 * it is exactly 0.3.0's behaviour: the id is accepted and the agent reports the problem later,
 * which is where Genie already was.
 *
 * Reported to prism; the real fix belongs in `probeSessionStore`, which should honour
 * `CLAUDE_CONFIG_DIR` the way the SDK it is probing for does.
 *
 * ## Why a `.mjs` beside the host
 *
 * `prism-host.mjs` is run by node directly (`prismHostPath()`), not bundled, so it cannot import
 * TypeScript. The decision still deserves a test, so it lives here and the host stays wiring.
 */
export function probeIsTrustworthy(env) {
    const configDir = (env.CLAUDE_CONFIG_DIR ?? '').trim();
    // Not set: the CLI uses `~/.claude` and so does the probe. They agree.
    if (!configDir) return true;

    const home = (env.HOME ?? env.USERPROFILE ?? '').trim();
    // `CLAUDE_CONFIG_DIR` is set and there is no home to compare it against. Cannot establish
    // that they agree, so do not claim it.
    if (!home) return false;

    // Set to the default location explicitly — common in a managed env, and harmless.
    return resolve(configDir) === resolve(join(home, '.claude'));
}
