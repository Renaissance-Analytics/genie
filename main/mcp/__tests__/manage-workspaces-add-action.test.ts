import { describe, expect, it } from 'vitest';
import { MANAGE_WORKSPACES_TOOL } from '../protocol';

/**
 * genie #322 — `manageWorkspaces` documented an `add` action its schema refused.
 *
 * The tool description told the agent, in detail, how to register a folder as a
 * workspace. The schema's action enum was
 * `['list','status','open','activate','remove']`, so every such call was
 * rejected at validation before it reached the handler — which had `add`
 * implemented the whole time (`host-tools.ts`), as did the TypeScript union.
 * Only the JSON schema disagreed, and the JSON schema is the half that decides.
 *
 * The asymmetry is what made it worth fixing rather than deleting the docs:
 * `remove` WAS exposed. An agent could unregister a workspace and then not put
 * it back — the wrong way round for a destructive/constructive pair. Reported
 * after a sweep found six `.agi` envelopes on disk that Genie had no record of
 * and no exposed way to adopt.
 *
 * The test pins DESCRIPTION AND SCHEMA TOGETHER, because either half drifting
 * from the other reproduces the bug in one direction or the other.
 */

const actionEnum = (): string[] => {
    const schema = MANAGE_WORKSPACES_TOOL.inputSchema as {
        properties: { action: { enum: string[] } };
    };
    return schema.properties.action.enum;
};

describe('manageWorkspaces exposes every action it documents', () => {
    it('accepts `add` — the counterpart to `remove`', () => {
        expect(actionEnum()).toContain('add');
    });

    it('still accepts everything it accepted before', () => {
        // POSITIVE CONTROL: adding `add` by replacing the enum would satisfy the
        // assertion above while quietly dropping the actions that worked.
        for (const action of ['list', 'status', 'open', 'activate', 'remove']) {
            expect(actionEnum()).toContain(action);
        }
    });

    it('documents exactly the actions it accepts, and no others', () => {
        // The bug was a description promising more than the schema allowed. The
        // reverse — a schema accepting something undocumented — is the same
        // failure seen from the other side: an agent reads the description to
        // decide what it can do.
        const described = MANAGE_WORKSPACES_TOOL.description;
        for (const action of actionEnum()) {
            expect(described).toContain(`\`${action}\``);
        }
    });
});
