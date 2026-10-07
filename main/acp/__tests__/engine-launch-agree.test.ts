import { describe, expect, it } from 'vitest';
import { engineFor } from '../../agents/engine';
import { acpLaunch, ACP_PROVIDERS } from '../agent-spec';

/**
 * `engineFor` AND `acpLaunch` MUST AGREE about which providers can run on ACP.
 *
 * They are two halves of one decision and they are in different files. `engineFor` reads
 * `ACP_PROVIDERS` to route an agent to the ACP engine; `acpLaunch` then decides what to
 * actually spawn — and refuses `no-acp-mode` for anything prism cannot drive.
 *
 * When they disagree the agent is routed to an engine that then refuses it, and the only
 * symptom is a console warning (`[acp] … did not start`) and an agent that never runs. No
 * exception, no failing test, no UI: the roster shows it, it does nothing.
 *
 * This matters now rather than later because the owner's direction is that ACP is the
 * mechanism and not a mode. Any provider where these two disagree is a provider that stops
 * working the moment ACP becomes the default.
 */

const ctx = { hostScript: () => '/fake/prism-host.mjs' } as never;

describe('the two halves of the ACP decision', () => {
    it.each([...ACP_PROVIDERS])('%s is routed to ACP and can actually launch', (provider) => {
        expect(engineFor({ provider, acpEnabled: true })).toBe('acp');
        const launch = acpLaunch(provider, ctx);
        expect(
            launch,
            `${provider} is in ACP_PROVIDERS, so engineFor routes it to ACP — but acpLaunch ` +
                'refuses it, which starts an agent that never runs and says so only in a log line',
        ).toMatchObject({ ok: true });
    });

    it('positive control: a provider OUTSIDE the list is refused by both', () => {
        // Without this, "they agree" would pass against two functions that both said no to
        // everything.
        expect(engineFor({ provider: 'aider', acpEnabled: true })).toBe('pty');
        expect(acpLaunch('aider', ctx)).toMatchObject({ ok: false, reason: 'no-acp-mode' });
    });
});
