export interface FancyComponent {
    package: string;
    version: string;
    export: string;
}

export interface PluginPanel {
    id: string;
    title: string;
    icon?: string;
    fancyComponent: FancyComponent;
    placement?: 'grid' | 'workspace';
}

export interface PluginEditor {
    id: string;
    title: string;
    extensions: string[];
    fancyEditor: FancyComponent;
    toolbarActions?: Array<{ id: string; title: string; icon?: string; mode?: string }>;
}

export interface PluginRecipeField {
    key: string; label: string; type?: 'text' | 'password' | 'number' | 'select';
    placeholder?: string; description?: string; required?: boolean;
    options?: Array<{ value: string; label: string; description?: string }>;
    defaultValue?: string;
}

export type PluginRecipeStep =
    | { type: 'form'; id: string; title: string; fields: PluginRecipeField[] }
    | { type: 'choice'; id: string; title: string; options: Array<{ value: string; label: string; description?: string }>; multi?: boolean }
    | { type: 'terminal'; id: string; title: string; command: string; args?: string[]; cwd?: string; until?: { pattern?: string; exit?: number }; capture?: string }
    | { type: 'browser'; id: string; title: string; url: string; pollMs?: number };

export interface PluginRecipe { id: string; title: string; steps: PluginRecipeStep[] }
export interface PluginOverlay { id: string; title: string; icon?: string; fancyComponent: FancyComponent }
export interface PluginPage { fancyComponent: FancyComponent }

export interface PluginTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    run?: string;
    process?: 'worker' | 'subprocess';
    gated?: boolean;
}

export interface PluginManifest {
    id: string;
    namespace: string;
    name: string;
    version: string;
    description?: string;
    publisher?: { name: string; url?: string; keyId?: string };
    engines?: { genie?: string };
    entry?: { tools?: string };
    agent?: { guide: string };
    contributes?: {
        mcpTools?: PluginTool[];
        editors?: PluginEditor[];
        panels?: PluginPanel[];
        recipes?: PluginRecipe[];
        flyouts?: PluginOverlay[];
        modals?: PluginOverlay[];
        wizards?: PluginRecipe[];
        workstationPage?: PluginPage;
        workspaceSettingsPage?: PluginPage;
    };
    capabilities?: {
        fs?: { scope: 'workspace' | 'none'; extensions?: string[] };
        network?: { hosts: string[] };
        genieApi?: string[];
    };
    dependencies?: Record<string, string>;
}

/** Type-check a manifest without changing the JSON Genie consumes. */
export function definePlugin<const T extends PluginManifest>(manifest: T): T {
    return manifest;
}
