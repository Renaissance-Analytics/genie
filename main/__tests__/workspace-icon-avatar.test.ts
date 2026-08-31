import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations, setAgentAvatar, setWorkspaceIcon } from '../db';

/**
 * A workspace's ICON and an agent's AVATAR are the user's to choose.
 *
 * Both columns exist and both READ paths render — `workspaceIcon()` prefers
 * `ws.icon` over the initials, and the avatar stack's `Face` prefers
 * `entry.avatar` over the provider's brand mark. Neither could be WRITTEN: no
 * accessor, no IPC, no control anywhere in the UI. So the fallback was not a
 * default, it was the only possible value, and "users should be able to change
 * the workspace icon in genie AND in tynn" was half a feature with the visible
 * half missing.
 *
 * Clearing matters as much as setting: a user who picks an emoji and changes
 * their mind has to be able to get the initials and the brand mark back, so
 * empty input stores NULL rather than an empty string that renders as a blank
 * square.
 */

function fresh(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
}

function seedWorkspace(db: Database.Database, id: string): void {
    db.prepare(
        `INSERT INTO workspaces
           (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
            shape, path, last_opened_at, created_by_genie)
         VALUES (?, 'tynn', ?, 'W', ?, 'W', 'simple', ?, null, 0)`,
    ).run(id, `p-${id}`, `p-${id}`, `/tmp/${id}`);
}

function seedAgent(db: Database.Database, id: string, workspaceId: string): void {
    db.prepare(
        `INSERT INTO workspace_agents
           (id, workspace_id, provider, name, purpose, avatar, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, 'p', NULL, ?, ?)`,
    ).run(id, workspaceId, id, Date.now(), Date.now());
}

const iconOf = (db: Database.Database, id: string) =>
    (db.prepare('SELECT icon FROM workspaces WHERE id = ?').get(id) as { icon: string | null }).icon;
const avatarOf = (db: Database.Database, id: string) =>
    (db.prepare('SELECT avatar FROM workspace_agents WHERE id = ?').get(id) as {
        avatar: string | null;
    }).avatar;

describe('setWorkspaceIcon', () => {
    it('stores the icon the user chose', () => {
        const db = fresh();
        seedWorkspace(db, 'w1');
        setWorkspaceIcon(db, 'w1', '🧪');
        expect(iconOf(db, 'w1')).toBe('🧪');
    });

    it('clears back to NULL, so the initials come back', () => {
        const db = fresh();
        seedWorkspace(db, 'w1');
        setWorkspaceIcon(db, 'w1', '🧪');
        setWorkspaceIcon(db, 'w1', '');
        // NOT '' — the renderer treats any truthy icon as the user's choice, so
        // an empty string would render an empty square forever.
        expect(iconOf(db, 'w1')).toBeNull();
        setWorkspaceIcon(db, 'w1', '   ');
        expect(iconOf(db, 'w1')).toBeNull();
        setWorkspaceIcon(db, 'w1', null);
        expect(iconOf(db, 'w1')).toBeNull();
    });

    it('refuses a value long enough to be a caption', () => {
        // The slot is one glyph wide. Anything longer is either a paste
        // accident or someone using the icon as a name field, and both render
        // as overflow in every workspace list.
        const db = fresh();
        seedWorkspace(db, 'w1');
        expect(() => setWorkspaceIcon(db, 'w1', 'a whole sentence of icon')).toThrow(/too long/i);
        expect(iconOf(db, 'w1')).toBeNull();
    });

    it('keeps a multi-codepoint emoji whole', () => {
        // A flag or a ZWJ sequence is several code units and one glyph.
        // Truncating by `.length` would store half an emoji.
        const db = fresh();
        seedWorkspace(db, 'w1');
        setWorkspaceIcon(db, 'w1', '👩‍💻');
        expect(iconOf(db, 'w1')).toBe('👩‍💻');
    });

    it('touches only the workspace named', () => {
        const db = fresh();
        seedWorkspace(db, 'w1');
        seedWorkspace(db, 'w2');
        setWorkspaceIcon(db, 'w1', '🧪');
        expect(iconOf(db, 'w2')).toBeNull();
    });
});

describe('setAgentAvatar', () => {
    it('stores and clears the same way', () => {
        const db = fresh();
        seedWorkspace(db, 'w1');
        seedAgent(db, 'a1', 'w1');
        setAgentAvatar(db, 'a1', '🐙');
        expect(avatarOf(db, 'a1')).toBe('🐙');
        setAgentAvatar(db, 'a1', '');
        // Cleared means the PROVIDER BRAND MARK comes back, which is the
        // default the owner asked for.
        expect(avatarOf(db, 'a1')).toBeNull();
    });

    it('refuses a caption here too', () => {
        const db = fresh();
        seedWorkspace(db, 'w1');
        seedAgent(db, 'a1', 'w1');
        expect(() => setAgentAvatar(db, 'a1', 'not an emoji at all')).toThrow(/too long/i);
    });

    it('touches only the agent named', () => {
        const db = fresh();
        seedWorkspace(db, 'w1');
        seedAgent(db, 'a1', 'w1');
        seedAgent(db, 'a2', 'w1');
        setAgentAvatar(db, 'a1', '🐙');
        expect(avatarOf(db, 'a2')).toBeNull();
    });
});
