/** Add genie-host's identity to an updater feed's YAML (scripts/feed-host-identity.mjs, Tynn #413). */
export function feedHostIdentity(yml: string, host: { hostScript: string; protocol: number }): string;
