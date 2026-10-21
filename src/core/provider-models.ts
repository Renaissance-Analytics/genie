// TYPES ONLY from prism-acp: this module is the renderer's too, and prism-acp's runtime spawns processes.
import type { AvailableModel, SessionModelState } from '@particle-academy/prism-acp';
import { isAcpProvider, type AcpProvider } from './engine.js';

/**
 * THE MODELS A PROVIDER OFFERS, AS THE PROVIDER SAYS (the owner, 2026-10-21: "make sure that the model selection for
 * agents is using actual available options from the providers. For example, I do not even see fable as an option").
 *
 * The picker offered a hardcoded sonnet / opus / haiku, so a model the signed-in account HAS — Fable — could not be
 * chosen, and every model a provider shipped after the list was written was missing the same way. There is no list
 * here now. prism-acp 0.22 asks the provider: `listModels` before a session exists (a short-lived CLI under the same
 * supervision as an agent's, no turn run), `driver.modelState()` on a running one. Genie shows what came back and
 * nothing else: an entry is the provider's `modelId` (what is passed back to select it), its `name`, its `description`,
 * what an alias resolves to, and whether it is the provider's default.
 *
 * What Genie never sees: Claude's `initialize` answer also carries the signed-in ACCOUNT (its email). prism hands back
 * the models alone, and nothing here asks for more.
 */

export type { AvailableModel, SessionModelState };

/**
 * A provider's models for the picker. `source` says whose answer it is: `session` — the running agent's own
 * (`currentModelId` is the model THAT session runs on); `provider` — a short-lived CLI asked before any session
 * (`current` is only the provider's default). `ok: false` is the provider not saying, with its reason.
 */
export type ModelChoices =
    | { readonly ok: true; readonly provider: string; readonly source: 'session' | 'provider'; readonly models: readonly AvailableModel[]; readonly current: string | null }
    | { readonly ok: false; readonly provider: string; readonly reason: string };

/** prism-acp's `listModels(provider, …)` with Genie's launch options already chosen (session-host `realListModels`). */
export type ListProviderModels = (provider: AcpProvider) => Promise<SessionModelState>;

/** Why a provider gave no list, in words a person can act on. prism's ModelListError names no path; say it as it is. */
export function modelListReason(provider: string, error: unknown): string {
    // By NAME, not instanceof: a type-only import (above), and a ModelListError is still one across module copies.
    if (error instanceof Error && error.name === 'ModelListError') return error.message;
    return `could not start ${provider}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * ONE ASK PER PROVIDER, KEPT UNTIL REFRESHED. Asking starts the provider's CLI (seconds, and a process), so a picker
 * opening must not do it each time: the answer — or the failure — is kept per provider, two pickers opening together
 * share one ask, and `refresh` asks again. A failure is kept too: a signed-out provider would otherwise start a CLI on
 * every open to be refused again; the person's Refresh is what retries. The list is the ACCOUNT's, not a workspace's,
 * so one per provider is right.
 */
export class ProviderModelCache {
    readonly #list: ListProviderModels;
    readonly #asked = new Map<AcpProvider, Promise<ModelChoices>>();

    constructor(list: ListProviderModels) {
        this.#list = list;
    }

    get(provider: string, options: { refresh?: boolean } = {}): Promise<ModelChoices> {
        if (!isAcpProvider(provider)) return Promise.resolve({ ok: false, provider, reason: `Genie cannot run a "${provider}" agent, so it has no models to list` });
        const kept = this.#asked.get(provider);
        if (kept && options.refresh !== true) return kept;
        const asking = this.#ask(provider);
        this.#asked.set(provider, asking);
        return asking;
    }

    async #ask(provider: AcpProvider): Promise<ModelChoices> {
        try {
            const state = await this.#list(provider);
            return { ok: true, provider, source: 'provider', models: state.availableModels, current: state.currentModelId };
        } catch (error) {
            return { ok: false, provider, reason: modelListReason(provider, error) };
        }
    }
}

/** An entry as the picker names it: the provider's name, and what an alias resolves to when that says more (`Fable → claude-fable-5-1`). */
export function modelLabel(model: AvailableModel): string {
    const resolved = model.resolvedModel;
    return resolved && resolved !== model.name && resolved !== model.modelId ? `${model.name} → ${resolved}` : model.name;
}

/**
 * What choosing an entry sets: the provider's DEFAULT entry (or the empty "provider's default") clears the choice —
 * the agent then starts with no `--model` at all, the provider's own default — and anything else is that model id.
 */
export function chosenModel(value: string, choices: ModelChoices): string | null {
    if (value === '') return null;
    if (choices.ok && choices.models.some((m) => m.modelId === value && m.isDefault === true)) return null;
    return value;
}

/** When a live switch takes effect (prism-acp 0.22): Claude's CLI switches at once; Codex sends the model with its next turn. */
export function switchTiming(provider: string): 'now' | 'next-turn' {
    return provider === 'codex' ? 'next-turn' : 'now';
}
