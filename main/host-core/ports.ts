/**
 * The GUI-free host-core contract — the seam between desktop Electron Genie and
 * the headless genie-cloud build (the "fancy-term-host extraction, one level
 * up"). Both shells compose the SAME core (DB + pty engine + MCP/control/mobile
 * servers) and inject these ports; everything Electron-shaped (windows, tray,
 * safeStorage, Notification, app-quit) stays behind them on the desktop side.
 *
 * Mirrors genie-cloud's `src/host-core/port.ts` (`HostCore.boot(opts, ports)`).
 * genie-cloud also injects security ports (grant resolver, audit shipper) into
 * the mobile server deps it builds — those are a later phase and not part of
 * this extraction; here we define the four GUI-decouple ports the brief names.
 */

import type { Encryptor } from '@particle-academy/fancy-term-host';
import type { ForceQuestion, ForceQuestionResult } from '../mcp/protocol';

/** Secrets-at-rest. Desktop injects the Electron `safeStorage` impl; genie-cloud
 *  a KMS/keyring-backed one. Re-exported from the terminal core's existing port
 *  so the whole app shares ONE encryptor contract. */
export type { Encryptor };

/**
 * The approval / question channel — the chokepoint every gate funnels through
 * (`forceQuestion`). Desktop injects the BrowserWindow modal; genie-cloud a
 * fail-closed transport that forwards to the driving member or DENIES.
 */
export interface QuestionTransport {
    ask(questions: ForceQuestion[], workspaceLabel?: string): Promise<ForceQuestionResult>;
}

/**
 * User-facing notifications (the imDone chime/toast). Desktop plays them via the
 * Electron `Notification` + window chime; genie-cloud logs / forwards to the
 * member over the relay.
 */
export interface Notifier {
    imDone(terminalId: string): void;
}

/**
 * Process presence: desktop is anchored by its tray + windows, headless has
 * neither so it must keep the event loop alive. Also the place a shell exposes
 * its quit path if the core ever needs to request one.
 */
export interface Lifecycle {
    /** Keep the process alive with no windows/tray (headless). No-op on desktop. */
    keepAlive(): void;
}

/**
 * An OPTIONAL background subscription the host runs alongside its servers. Used
 * for the workspace-assignment PUSH subscriber (auto-provision on assign — no
 * polling): the genie-cloud shell builds it (createWorkspaceAssignmentSubscriber,
 * wired with its Pusher transport on Tynn's private `workstation.{id}` channel +
 * the host-token reconcile fetch) and injects it here. Desktop Genie omits it —
 * a member desktop doesn't HOST workspaces. Absent ⇒ the boot step is a no-op.
 */
export interface BackgroundSubscription {
    start(): void | Promise<void>;
    stop(): void | Promise<void>;
}

/** The ports the host-core consumes instead of its Electron defaults. */
export interface HostCorePorts {
    encryptor: Encryptor;
    questionTransport: QuestionTransport;
    notifier: Notifier;
    lifecycle: Lifecycle;
    /** Optional: the workspace-assignment push subscriber (headless only). */
    workspaceAssignments?: BackgroundSubscription;
}

export interface HostBootOptions {
    /** Where the host-core keeps its DB (+ per-workspace volumes, later). */
    dataDir: string;
    /** Reported in MCP/mobile server-info responses. */
    serverVersion: string;
    /**
     * Phase 0–3: true — bind every server to loopback only, no relay surface.
     * Flipped false only once relay + PoP + scope enforcement land (Phase 4).
     */
    loopbackOnly: boolean;
}

/** A booted host-core: the ports it actually bound + a clean shutdown. */
export interface HostHandle {
    /** Bound MCP port, or null if it failed to bind. */
    mcpPort: number | null;
    /** Bound mobile/remote-API port, or null. */
    mobilePort: number | null;
    /** Stop every server + the terminal backend; release the DB. */
    shutdown(): Promise<void>;
}

export interface HostCore {
    /**
     * Boot the GUI-free host-core with the injected security ports. Resolves
     * once the DB + terminal backend + MCP/control/mobile servers are up.
     */
    boot(opts: HostBootOptions, ports: HostCorePorts): Promise<HostHandle>;
}
