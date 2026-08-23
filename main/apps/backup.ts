import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import {
    getAllSettings,
    getAppBackupJson,
    getAppGrant,
    getWorkspaceDevServices,
    setAppBackupJson,
    setSettings,
} from '../db';
import { resolveContainerRuntime } from '../dev-server';
import { devServiceManager } from '../dev-server/services/service-manager';
import {
    parseBackupOverride,
    parseBackupSettings,
    resolveBackupSettings,
} from '../dev-server/services/backup';
import { backupApp } from '../dev-server/services/backup-app';
import { runBackupJob } from '../dev-server/services/backup-runner';
import type { BackupOverride, BackupSettings, ResolvedBackup } from '../dev-server/services/backup';
import type { AppBackupRun } from '../dev-server/services/backup-app';
import type { BackupHostFs } from '../dev-server/services/backup-runner';

/**
 * The SHELL half of GApp backups (Tynn #250, step 4).
 *
 * Everything that decides what runs and where it lands is pure and lives under
 * `dev-server/services/` (`backup.ts`, `backup-app.ts`, `backup-runner.ts`).
 * This file supplies the four things only the desktop knows: the machine's name,
 * Genie's data folder, a real filesystem, and the container runtime.
 *
 * Kept out of the pure modules on purpose — `os.hostname()` and
 * `app.getPath('userData')` are exactly the kind of ambient fact that makes a
 * decision untestable, and every one of them is an argument on the other side of
 * this seam.
 */

/** Where dumps go until the owner points the setting somewhere else — a shared
 *  folder being the case this whole feature exists for. */
function defaultBackupDir(): string {
    try {
        return path.join(app.getPath('userData'), 'backups');
    } catch {
        // No Electron app object (a headless host, a test): the home folder is a
        // real place, and an empty default would silently disable backups.
        return path.join(os.homedir(), '.genie', 'backups');
    }
}

export function workstationBackupSettings(): BackupSettings {
    return parseBackupSettings(getAllSettings().gapp_backup, { dir: defaultBackupDir() });
}

export interface AppBackupSettingsView {
    /** The machine's default — what an app inherits when it says nothing. */
    workstation: BackupSettings;
    /** This app's override, or null when it follows the default. */
    override: BackupOverride | null;
    /** What the two come out as, and which level decided each field. */
    resolved: ResolvedBackup;
}

export function appBackupSettings(appId: string): AppBackupSettingsView {
    const workstation = workstationBackupSettings();
    const override = parseBackupOverride(getAppBackupJson(appId));
    return { workstation, override, resolved: resolveBackupSettings(workstation, override) };
}

/** Write the WORKSTATION default. Fields left out keep their current value. */
export function setWorkstationBackupSettings(patch: Partial<BackupSettings>): BackupSettings {
    const next = { ...workstationBackupSettings(), ...patch };
    setSettings({ gapp_backup: JSON.stringify(next) });
    return next;
}

/** Write ONE app's override. `null` clears it, so the app follows the default
 *  again — which is a different state from "override everything to the current
 *  default", and the one someone means when they press Reset. */
export function setAppBackupOverride(appId: string, override: BackupOverride | null): void {
    setAppBackupJson(appId, override && Object.keys(override).length ? JSON.stringify(override) : null);
}

/** The real filesystem, behind the seam the runner takes. */
const hostFs: BackupHostFs = {
    async ensureDir(dir) {
        await fs.mkdir(dir, { recursive: true });
    },
    async list(dir) {
        return fs.readdir(dir);
    },
    async remove(target) {
        await fs.rm(target, { force: true });
    },
    async exists(target) {
        try {
            await fs.access(target);
            return true;
        } catch {
            return false;
        }
    },
    async size(target) {
        return (await fs.stat(target)).size;
    },
};

/**
 * Back one installed GApp's data up now. Never throws — a backup is driven by a
 * button, a schedule or an agent, and an exception in any of those is a stack
 * trace where the reason should be.
 */
export async function backupAppNow(appId: string, at = new Date()): Promise<AppBackupRun> {
    const grant = getAppGrant(appId);
    if (!grant) {
        return { ok: false, skipped: `No installed app ${appId}.`, notCovered: [], results: [] };
    }

    const manager = devServiceManager();
    const runtime = await resolveContainerRuntime()
        .then((resolved) => resolved.runtime)
        .catch(() => null);
    if (!manager || !runtime) {
        return {
            ok: false,
            skipped:
                'No container runtime is available, so this app’s engines cannot be dumped. ' +
                'Start Docker or Podman and try again.',
            notCovered: [],
            results: [],
        };
    }

    // LIVE engines only. Dumping a stopped one reports a connection error, which
    // is a failed backup wearing a database's clothes — `backup-app.ts` names the
    // gap instead.
    const running = new Set(
        manager
            .list(grant.workspaceId)
            .filter((row) => row.state === 'running')
            .map((row) => row.serviceId),
    );

    const settings = workstationBackupSettings();
    return backupApp(
        {
            app: { slug: grant.slug, workspaceId: grant.workspaceId },
            machine: os.hostname() || 'workstation',
            at,
            settings,
            override: parseBackupOverride(getAppBackupJson(appId)),
            services: getWorkspaceDevServices(grant.workspaceId),
            running,
        },
        (job, root, keep) =>
            runBackupJob(job, root, {
                runtime,
                fs: hostFs,
                join: (...parts) => path.join(...parts),
                platform: process.platform,
                nameSuffix: () => randomBytes(4).toString('hex'),
            }, keep),
    );
}
