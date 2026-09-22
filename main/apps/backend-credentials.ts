import type { AppGrant } from './bridge-decision';
import { randomBytes } from 'node:crypto';
export type CredentialRows = Record<string, { appId: string; grant: string }>;
const stamp = (grant: AppGrant) => JSON.stringify(grant);
export class AppCredentials {
    private rows: CredentialRows;
    constructor(
        private lookup: (id: string) => AppGrant | null,
        rows: CredentialRows = {},
        private save: (rows: CredentialRows) => void = () => {},
    ) { this.rows = { ...rows }; }
    mint(id: string): string {
        const grant = this.lookup(id);
        if (!grant || grant.revoked) throw new Error('This app has no active permission grant.');
        const fingerprint = stamp(grant);
        for (const [token, row] of Object.entries(this.rows)) {
            if (row.appId === id && row.grant === fingerprint) return token;
        }
        this.revoke(id);
        const token = randomBytes(32).toString('base64url');
        this.rows[token] = { appId: id, grant: fingerprint };
        try { this.save(this.rows); }
        catch (error) { delete this.rows[token]; throw error; }
        return token;
    }
    resolve(token: string): { grant?: AppGrant; error?: string } {
        const row = this.rows[token];
        if (!row) return { error: 'Unknown or revoked app credential.' };
        const grant = this.lookup(row.appId);
        if (!grant || grant.revoked || stamp(grant) !== row.grant) {
            this.revoke(row.appId);
            return { error: 'The app permission grant changed or was revoked. Restart its backend to receive a new credential.' };
        }
        return { grant };
    }
    revoke(id: string): void {
        let changed = false;
        for (const [token, row] of Object.entries(this.rows)) {
            if (row.appId === id) { delete this.rows[token]; changed = true; }
        }
        if (changed) this.save(this.rows);
    }
}
