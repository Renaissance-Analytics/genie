import { describe, expect, it } from 'vitest';

import { guestEventPayload } from '../guest-access';
import type { MobileDataDeps } from '../api';
import type { HostAccessPolicy } from '../../host-core/access-policy';

/**
 * Which `/ws/events` pushes a GUEST socket receives (genie-cloud#33). The socket
 * suite (guest-server.integration.test.ts) covers the wiring with a few event
 * types; this pins the decision for every type a guest is sent, and that anything
 * unclassified is withheld.
 */

const SHARED = { id: 'ws-shared', project_name: 'Shared App', path: '/w/shared' };
const PRIVATE = { id: 'ws-private', project_name: 'Private Payroll', path: '/w/private' };

const deps = {
    listWorkspaces: () => [SHARED, PRIVATE],
    listTerminalSpecs: () => [
        { id: 't-shared', workspace_id: SHARED.id },
        { id: 't-private', workspace_id: PRIVATE.id },
    ],
    listAllProcesses: () => [
        { id: 'p-shared', workspaceId: SHARED.id },
        { id: 'p-private', workspaceId: PRIVATE.id },
    ],
    listPendingQuestions: () => [
        { id: 'q1', workspacePath: SHARED.path },
        { id: 'q2', workspacePath: PRIVATE.path },
        { id: 'q3', workspacePath: PRIVATE.path },
    ],
} as unknown as MobileDataDeps;

const policy: HostAccessPolicy = {
    principalId: 'guest',
    principalType: 'tynn-user',
    transports: ['tynn'],
    capability: 'control',
    workspaceScopes: [`workspace:${SHARED.id}`],
    sitePermissions: {},
};

const receives = (type: string, payload: unknown) => guestEventPayload(policy, deps, type, payload);

describe('guest pushes', () => {
    it.each([
        ['terminal:attention', { id: 't-shared', on: true }, { id: 't-private', on: true }],
        ['schedule:next', { id: 'p-shared', nextAt: 1 }, { id: 'p-private', nextAt: 1 }],
        ['process:status', { id: 'p-shared', status: 'running' }, { id: 'p-private', status: 'running' }],
        ['workspace:pulse', { workspaceId: SHARED.id }, { workspaceId: PRIVATE.id }],
        ['lists:changed', { workspaceId: SHARED.id }, { workspaceId: PRIVATE.id }],
        ['agent-pulse', { workspaceId: SHARED.id, active: true, bytes: 1 }, { workspaceId: PRIVATE.id, active: true, bytes: 1 }],
        ['agent:thumbs-up', { workspaceId: SHARED.id, agentId: 'a' }, { workspaceId: PRIVATE.id, agentId: 'b' }],
        ['notify:imdone', { workspaceId: SHARED.id, label: 'shell' }, { workspaceId: PRIVATE.id, label: 'payroll' }],
        ['dev-server:site-progress', { workspaceId: SHARED.id, siteId: 's' }, { workspaceId: PRIVATE.id, siteId: 'p' }],
    ])('%s: delivered for the shared workspace, withheld for the private one', (type, shared, other) => {
        expect(receives(type, shared)).toEqual(shared);
        expect(receives(type, other)).toBeUndefined();
    });

    it('withholds a notice that does not say which workspace it is about', () => {
        expect(receives('notify:imdone', { label: 'shell', workspace: 'Shared App' })).toBeUndefined();
    });

    it('recounts pending questions over the guest\'s workspace only', () => {
        expect(receives('questions:changed', { count: 3, workspaces: 2 })).toEqual({ count: 1, workspaces: 1 });
    });

    it('narrows IssueWatch counts and errors to the shared workspace', () => {
        expect(
            receives('issue-watch:update', {
                counts: { [SHARED.id]: 2, [PRIVATE.id]: 5 },
                errors: { [PRIVATE.id]: { error: 'unauthenticated' } },
                needsReauth: true,
            }),
        ).toEqual({ counts: { [SHARED.id]: 2 }, errors: {}, needsReauth: true });
    });

    it.each(['workspaces:changed', 'terminal-spec:changed', 'agents:changed', 'dev-server:changed', 'control:changed'])(
        '%s passes (a re-fetch nudge, or already per recipient)',
        (type) => {
            expect(receives(type, { any: 1 })).toEqual({ any: 1 });
        },
    );

    it.each(['agentinbox:message', 'agentinbox:presence', 'agentinbox:escalation', 'update:changed', 'something:new'])(
        '%s is withheld (not classified for guests)',
        (type) => {
            expect(receives(type, { workspaceId: SHARED.id })).toBeUndefined();
        },
    );
});
