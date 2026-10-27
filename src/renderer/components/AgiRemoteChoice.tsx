import { Icon, Select } from '@particle-academy/react-fancy';
import { defaultRemoteChoice, githubOwnerOptions, remotePlanText, type Published, type PublishStep, type RemoteChoice } from '../../core/agi-remote.js';
import type { GithubView } from '../../core/github.js';

/**
 * WHERE THE NEW WORKSPACE IS KEPT (Add workspace parity items 10 + 11) — on New and on the wizard's Workspace step.
 *
 * Genie 1's three choices (InteractiveUpgradeWizard.tsx :1719-1787): No remote / GitHub (auto-create) / Paste URL; for
 * GitHub its owner picker (GitHubConnect.tsx OwnerSelect: the person and every org the App is installed on, "Genie isn't
 * installed on X — Install here…", "Install Genie on another account/org…") and the private toggle; and the plan line
 * (AddWorkspaceModal.tsx ContainerRepoNote). The owner, 2026-10-21: GitHub is optional — None comes first, and is the
 * default without a GitHub sign-in (core/agi-remote.ts).
 *
 * After the build, PublishedView is Genie 1's partial success (AddWorkspaceModal.tsx :446-471): "<name> is ready", where
 * it is, and each step that failed in the service's own words.
 *
 * Both are hook-free, so a test can render and press them.
 */

/**
 * What the remote choice asks of GitHub: sign in, the install chooser, read again — or `{ approve }`, the page of one
 * installation that has not granted what creating a repository needs (core/github.ts repoCreateBlocker), where a pending
 * permission request is approved.
 */
export type GithubAsk = 'sign-in' | 'install' | 'refresh' | { readonly approve: number };

const chip = (on: boolean) => `rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${on ? 'border-[var(--violet-400)] bg-[var(--violet-500)]/15 text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-3)] hover:bg-[var(--bg-2)]'}`;
const muted = 'text-xs text-[var(--fg-3)]';
const link = 'text-xs text-[var(--violet-400)] underline-offset-2 hover:underline';
const button = 'rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]';

const KIND_LABEL: Record<RemoteChoice['kind'], string> = { none: 'None (this machine only)', github: 'GitHub', paste: 'Paste URL' };

export interface RemoteChoiceProps {
    readonly choice: RemoteChoice;
    /** The GitHub sign-in as Settings shows it; `null` = this Genie has none to show. */
    readonly github: GithubView | null;
    /** The envelope's folder, `<slug>.agi` — the repository's name. */
    readonly folder: string;
    readonly onChoice: (choice: RemoteChoice) => void;
    readonly onGithub: (ask: GithubAsk) => void;
}

export function RemoteChoiceView({ choice, github, folder, onChoice, onGithub }: RemoteChoiceProps) {
    const signedIn = github?.status === 'signed-in';
    const pick = (kind: RemoteChoice['kind']) => {
        if (kind === choice.kind) { onChoice(choice); return; }
        if (kind === 'none') onChoice({ kind: 'none' });
        else if (kind === 'paste') onChoice({ kind: 'paste', url: '' });
        else onChoice(defaultRemoteChoice(github));
    };
    const name = folder || '<name>.agi';
    return (
        <div data-remote-choice={choice.kind} className="flex flex-col gap-2">
            <span className="text-xs font-semibold">Where it is kept</span>
            <div className="flex flex-wrap gap-2">
                {(['none', 'github', 'paste'] as const).map((k) => (
                    <button key={k} type="button" data-remote-kind={k} aria-pressed={choice.kind === k} disabled={k === 'github' && !signedIn} onClick={() => pick(k)} className={chip(choice.kind === k)}>
                        {k === 'github' ? <span className="inline-flex items-center gap-1"><Icon name="github" size="xs" />{KIND_LABEL[k]}</span> : KIND_LABEL[k]}
                    </button>
                ))}
            </div>
            {!signedIn ? (
                <span className={muted}>
                    Genie can create the repository on GitHub when you are signed in.{' '}
                    <button type="button" data-action="github-sign-in" onClick={() => onGithub('sign-in')} className={link}>Sign in to GitHub…</button>
                </span>
            ) : null}
            {choice.kind === 'paste' ? (
                <input
                    data-field="remote-url"
                    aria-label="Remote URL"
                    value={choice.url}
                    placeholder={`git@github.com:owner/${name}.git`}
                    onChange={(e) => onChoice({ kind: 'paste', url: e.target.value })}
                    className="rounded-md border border-[var(--border-1)] bg-[var(--bg-0)] px-2.5 py-1.5 font-mono text-xs"
                />
            ) : null}
            {choice.kind === 'github' && signedIn && github ? GithubOwner({ choice, github, onChoice, onGithub }) : null}
            <span data-remote-plan="" className={muted}>{remotePlanText(choice, name)}</span>
        </div>
    );
}

/** Genie 1's OwnerSelect and the private toggle — a call, not a component, so the tree stays one a test can walk. */
function GithubOwner({ choice, github, onChoice, onGithub }: { choice: Extract<RemoteChoice, { kind: 'github' }>; github: GithubView; onChoice: (c: RemoteChoice) => void; onGithub: (a: GithubAsk) => void }) {
    return (
        <div className="flex flex-col gap-1.5">
            {OwnerPicker({ label: 'Create under', field: 'remote-owner', value: choice.owner, github, why: 'to create the repository under this account', onOwner: (v) => onChoice({ ...choice, owner: v }), onGithub })}
            <label className="inline-flex items-center gap-2 text-xs">
                <input type="checkbox" data-field="remote-private" checked={choice.private} onChange={(e) => onChoice({ ...choice, private: e.target.checked })} />
                Private repository
            </label>
            <span className={muted}>
                Don&apos;t see an account?{' '}
                <button type="button" data-action="github-install-other" onClick={() => onGithub('install')} className={link}>Install Genie on another account/org…</button>{' '}
                <button type="button" data-action="github-refresh" onClick={() => onGithub('refresh')} className={link}>Check again</button>
            </span>
        </div>
    );
}

/**
 * Genie 1's OwnerSelect, shared by "Where it is kept" and the Repos step's Fork (Add workspace parity item 12): the person
 * and every org the App is installed on, and — when the chosen account has no installation — the install, right there.
 * A call, not a component, so the tree stays one a test can walk.
 */
export function OwnerPicker({ label, field, value, github, why, onOwner, onGithub }: { label: string; field: string; value: string; github: GithubView; why: string; onOwner: (login: string) => void; onGithub: (a: GithubAsk) => void }) {
    const options = githubOwnerOptions(github);
    const chosen = options.find((o) => o.login.toLowerCase() === value.toLowerCase());
    return (
        <>
            <span className="text-xs font-semibold">{label}</span>
            <Select
                data-field={field}
                aria-label={label}
                list={options.map((o) => ({ value: o.login, label: `${o.login} · ${o.personal ? 'personal' : 'org'}` }))}
                value={value}
                onValueChange={(v: string) => onOwner(v)}
            />
            {chosen && chosen.installed === false ? (
                <span className="flex items-center gap-2 text-xs text-[var(--amber-400)]">
                    <span className="flex-1">Genie isn&apos;t installed on <strong>{chosen.login}</strong> — install it there {why}.</span>
                    <button type="button" data-action="github-install" onClick={() => onGithub('install')} className={button}>Install here…</button>
                </span>
            ) : null}
            {chosen?.approve ? (
                <span className="flex items-center gap-2 text-xs text-[var(--amber-400)]">
                    <span className="flex-1">{chosen.approve.reason}</span>
                    <button type="button" data-action="github-approve" onClick={() => onGithub({ approve: chosen.approve!.installationId })} className={button}>Approve on GitHub…</button>
                </span>
            ) : null}
        </>
    );
}

const STEP_LABEL: Record<PublishStep, string> = { github: 'GitHub', remote: 'Remote', push: 'Push', tynn: 'Tynn' };

export interface PublishedViewProps {
    readonly name: string;
    readonly path: string;
    readonly published: Published;
    readonly onOpen: () => void;
    readonly onGithub: (ask: GithubAsk) => void;
}

/** Genie 1's partial success: the workspace is made; what did not go to plan, by step, in the service's words. */
export function PublishedView({ name, path, published, onOpen, onGithub }: PublishedViewProps) {
    const notInstalled = published.problems.find((p) => p.account);
    const needsApproval = published.problems.find((p) => p.approve)?.approve;
    return (
        <div data-published="" className="flex flex-col gap-3 text-sm">
            <div>
                <h2 className="text-base font-semibold">{name} is ready</h2>
                <p className={muted}>The workspace is at <span className="font-mono">{path}</span>. What did not go to plan does not affect it — you can connect it to a repository later.</p>
            </div>
            <ul className="flex flex-col gap-1.5">
                {published.problems.map((p, i) => (
                    <li key={`${p.step}-${i}`} data-publish-problem={p.step} className="rounded-md border border-[var(--amber-400)] bg-[var(--amber-400)]/10 px-2.5 py-1.5 text-xs">
                        <strong>{STEP_LABEL[p.step]}:</strong> {p.message}
                    </li>
                ))}
            </ul>
            <div className="flex items-center justify-end gap-2">
                {notInstalled ? <button type="button" data-action="github-install" onClick={() => onGithub('install')} className={button}>Install Genie on {notInstalled.account}…</button> : null}
                {needsApproval ? <button type="button" data-action="github-approve" onClick={() => onGithub({ approve: needsApproval.installationId })} className={button}>Approve on GitHub…</button> : null}
                <button type="button" data-action="open-workspace" onClick={onOpen} className="flex items-center gap-1.5 rounded-md bg-[var(--violet-500)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--violet-400)]"><Icon name="check" size="xs" />Open workspace</button>
            </div>
        </div>
    );
}
