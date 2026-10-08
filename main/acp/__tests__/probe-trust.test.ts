import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain `.mjs` beside the host script, which node runs unbundled.
import { probeIsTrustworthy } from '../probe-trust.mjs';

/**
 * A FIX IS A HYPOTHESIS, including one somebody else shipped.
 *
 * prism-acp 0.4.0 added `probeSession` so a `session/load` for a conversation that does not exist
 * refuses at load, instead of coming up "resumed" and dying on its first prompt. Genie asked for
 * it. Measured before adopting it, `probeSessionStore` reads
 * `(home ?? homedir()) + '/.claude/projects'` and **never looks at `CLAUDE_CONFIG_DIR`** — while
 * the claude CLI resolves `CLAUDE_CONFIG_DIR ?? ~/.claude`, which is exactly why
 * `main/acp/agent-spec.ts` forwards that variable: the subscription credential lives there.
 *
 * So on an installation with that variable pointing elsewhere, the probe reads a store the CLI
 * does not use, finds nothing, and reports `absent` for a conversation that exists — refusing a
 * resume that would have worked. prism's own note says that is the worse of the two failures,
 * which is why `indeterminate` exists.
 *
 * Hence this gate. Omitting the probe is precisely 0.3.0's behaviour, which is where Genie
 * already was, so the fallback costs nothing that is not already the status quo.
 */

describe('probeIsTrustworthy', () => {
    it('trusts it when CLAUDE_CONFIG_DIR is not set', () => {
        // The ordinary case: the CLI uses `~/.claude` and so does the probe.
        expect(probeIsTrustworthy({ HOME: '/home/glenn' })).toBe(true);
        expect(probeIsTrustworthy({})).toBe(true);
    });

    it('trusts it when CLAUDE_CONFIG_DIR names the DEFAULT location explicitly', () => {
        // Common in a managed environment, and harmless — the two agree.
        expect(
            probeIsTrustworthy({ HOME: '/home/glenn', CLAUDE_CONFIG_DIR: '/home/glenn/.claude' }),
        ).toBe(true);
    });

    it('tolerates a trailing separator and a relative-looking path', () => {
        expect(
            probeIsTrustworthy({ HOME: '/home/glenn', CLAUDE_CONFIG_DIR: '/home/glenn/./.claude/' }),
        ).toBe(true);
    });

    it('REFUSES when CLAUDE_CONFIG_DIR points somewhere else', () => {
        // The case that matters. The CLI's sessions are under that directory; the probe would read
        // `~/.claude/projects`, find nothing, and call a live conversation absent.
        expect(
            probeIsTrustworthy({ HOME: '/home/glenn', CLAUDE_CONFIG_DIR: '/opt/genie/claude-config' }),
        ).toBe(false);
    });

    it('REFUSES when the variable is set and there is no home to compare it against', () => {
        // Cannot establish that they agree, so do not claim it. The direction of the error is the
        // whole point: a missed bad id fails late, a refused good id loses a conversation.
        expect(probeIsTrustworthy({ CLAUDE_CONFIG_DIR: '/opt/genie/claude-config' })).toBe(false);
    });

    it('reads USERPROFILE too, because that is the home Windows passes', () => {
        expect(
            probeIsTrustworthy({
                USERPROFILE: 'C:\\Users\\glenn',
                CLAUDE_CONFIG_DIR: 'C:\\Users\\glenn\\.claude',
            }),
        ).toBe(true);
        expect(
            probeIsTrustworthy({ USERPROFILE: 'C:\\Users\\glenn', CLAUDE_CONFIG_DIR: 'D:\\claude' }),
        ).toBe(false);
    });

    it('treats a whitespace-only value as unset rather than as a path', () => {
        expect(probeIsTrustworthy({ HOME: '/home/glenn', CLAUDE_CONFIG_DIR: '   ' })).toBe(true);
    });
});
