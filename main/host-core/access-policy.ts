export type NetworkScope = 'local' | 'lan' | 'tailscale' | 'tynn';
export type AccessCapability = 'readonly' | 'control';
export type SitePermission = 'browse' | 'interact';
export type WorkspaceScope = 'host:all' | `workspace:${string}`;

export interface HostAccessPolicy {
    principalId: string;
    principalType: 'owner' | 'device' | 'tynn-user';
    transports: NetworkScope[];
    capability: AccessCapability;
    workspaceScopes: WorkspaceScope[];
    sitePermissions: Record<string, SitePermission>;
    revokedAt?: number;
}

export interface AccessDecision {
    allowed: boolean;
    reason?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function ownerAccessPolicy(principalId = 'local-owner'): HostAccessPolicy {
    return {
        principalId,
        principalType: 'owner',
        transports: ['local', 'lan', 'tailscale', 'tynn'],
        capability: 'control',
        workspaceScopes: ['host:all'],
        sitePermissions: { '*': 'interact' },
    };
}

export function policyAllowsTransport(
    policy: HostAccessPolicy,
    transport: NetworkScope,
): AccessDecision {
    if (policy.revokedAt !== undefined) return { allowed: false, reason: 'principal revoked' };
    return policy.transports.includes(transport)
        ? { allowed: true }
        : { allowed: false, reason: `transport ${transport} is not granted` };
}

export function policyAllowsWorkspace(
    policy: HostAccessPolicy,
    workspaceId: string,
    write = false,
): AccessDecision {
    if (policy.revokedAt !== undefined) return { allowed: false, reason: 'principal revoked' };
    const scoped =
        policy.workspaceScopes.includes('host:all') ||
        policy.workspaceScopes.includes(`workspace:${workspaceId}`);
    if (!scoped) return { allowed: false, reason: 'workspace is not granted' };
    if (write && policy.capability !== 'control') {
        return { allowed: false, reason: 'workspace write requires control' };
    }
    return { allowed: true };
}

export function policyAllowsSite(
    policy: HostAccessPolicy,
    input: {
        workspaceId: string;
        siteId: string;
        method?: string;
        websocket?: boolean;
    },
): AccessDecision {
    const workspace = policyAllowsWorkspace(policy, input.workspaceId, false);
    if (!workspace.allowed) return workspace;

    const permission = policy.sitePermissions[input.siteId] ?? policy.sitePermissions['*'];
    if (!permission) return { allowed: false, reason: 'site is not explicitly granted' };
    const interactive =
        input.websocket === true ||
        !SAFE_METHODS.has((input.method ?? 'GET').toUpperCase());
    if (interactive && permission !== 'interact') {
        return { allowed: false, reason: 'site interaction requires interact permission' };
    }
    return { allowed: true };
}

export function visibleWorkspaceIds(
    policy: HostAccessPolicy,
    availableWorkspaceIds: Iterable<string>,
): Set<string> {
    const available = new Set(availableWorkspaceIds);
    if (policy.revokedAt !== undefined) return new Set();
    if (policy.workspaceScopes.includes('host:all')) return available;
    return new Set(
        policy.workspaceScopes
            .filter((scope): scope is `workspace:${string}` => scope.startsWith('workspace:'))
            .map((scope) => scope.slice('workspace:'.length))
            .filter((id) => available.has(id)),
    );
}

