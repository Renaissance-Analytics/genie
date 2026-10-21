import { planAdd, type PlanStep } from './workspace-model.js';

/**
 * ADD A WORKSPACE FROM TYNN (§6.1) — the pure half.
 *
 * Signed in (main/tynn-account.ts), Genie lists the person's projects (Genie 1's `GET /api/v1/projects`, over the session) and the
 * person picks one, as in Genie 1. Tynn exposes no repositories there. So "from Tynn" is the ENVELOPE from the
 * project: a folder named by the slug under the parent you pick, `project.json` carrying the
 * project's name, its vision as the description, and the `tynn` link the envelope schema defines
 * (`host`, `project`, `projectId`; `owner` only when known — never guessed). Repos follow through
 * the repo registry. The plan is shown before anything is written, like every other source.
 */

export interface TynnProject {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly vision: string | null;
}

/**
 * WHERE TYNN IS (the owner, 2026-10-21: "tynn is not a changeable host"). Testing reaches a local Tynn through the test
 * VM's hosts file (tynn.ai → this machine's tynn.gen), never through a product setting.
 */
export const TYNN_HOST = 'https://tynn.ai';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The project endpoint's own shape, and nothing it did not say. Null for anything that is not a project. */
export function parseTynnProject(raw: unknown): TynnProject | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'number' ? String(r.id) : typeof r.id === 'string' ? r.id : null;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const slug = typeof r.slug === 'string' ? r.slug.trim() : '';
    if (id === null || name.length === 0 || !SLUG.test(slug) || slug.includes('..')) return null;
    const vision = typeof r.vision === 'string' && r.vision.trim().length > 0 ? r.vision.trim() : null;
    return { id, name, slug, vision };
}


export interface TynnLink {
    readonly host: string;
    readonly project: string;
    readonly projectId: string;
}

export function tynnLink(project: TynnProject, host: string): TynnLink {
    return { host: host.replace(/\/+$/, ''), project: project.slug, projectId: project.id };
}

export type TynnAddPlan =
    | { ok: true; source: 'tynn'; project: TynnProject; host: string; parent: string; path: string; kind: 'empty'; steps: PlanStep[]; manifest: { name: string; description: string; tynn: TynnLink } }
    | { ok: false; reason: string };

/** The plan: create the folder (a write), then the empty-envelope steps, with the Tynn link named; nothing written here. */
export function tynnAddPlan(input: { project: TynnProject; parent: string; folderExists: boolean; host: string }): TynnAddPlan {
    const parent = input.parent.replace(/[\\/]+$/, '');
    const path = `${parent}/${input.project.slug}`;
    if (input.folderExists) return { ok: false, reason: `${path} already exists; add that folder instead of creating the Tynn envelope over it` };
    const link = tynnLink(input.project, input.host);
    const steps: PlanStep[] = [
        { action: `create ${path}`, path, writes: true },
        ...planAdd('empty', path).filter((s) => s.action !== 'register in Genie'),
        { action: `link to Tynn project ${input.project.name} (${link.host})`, path, writes: true },
        { action: 'register in Genie', path, writes: false },
    ];
    return {
        ok: true,
        source: 'tynn',
        project: input.project,
        host: link.host,
        parent,
        path,
        kind: 'empty',
        steps,
        manifest: { name: input.project.name, description: input.project.vision ?? '', tynn: link },
    };
}
