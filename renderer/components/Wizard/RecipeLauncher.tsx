import { useEffect, useState } from 'react';
import { Action, Icon, Modal, Text } from '@particle-academy/react-fancy';
import { listLaunchableRecipes, type LaunchableRecipe } from '../../lib/recipes';
import WizardModal from './WizardModal';

interface Props {
    /** Scope passed through to the launched recipe. */
    workspaceId?: string;
    workstationId?: string;
    defaultCwd?: string;
    onClose: () => void;
}

/**
 * A small picker that reads the recipe registry (built-in + plugin-contributed,
 * via listLaunchableRecipes) and launches the chosen recipe in a WizardModal.
 * This is the "launcher" the plugin `recipes` surface feeds — a plugin that
 * declares recipes and holds the `recipes` grant appears here automatically.
 */
export default function RecipeLauncher({ workspaceId, workstationId, defaultCwd, onClose }: Props) {
    const [recipes, setRecipes] = useState<LaunchableRecipe[] | null>(null);
    const [chosen, setChosen] = useState<LaunchableRecipe | null>(null);

    useEffect(() => {
        let alive = true;
        void listLaunchableRecipes().then((r) => {
            if (alive) setRecipes(r);
        });
        return () => {
            alive = false;
        };
    }, []);

    if (chosen) {
        return (
            <WizardModal
                recipe={chosen.recipe}
                workspaceId={workspaceId}
                workstationId={workstationId}
                defaultCwd={defaultCwd}
                onClose={onClose}
            />
        );
    }

    return (
        <Modal open onClose={onClose} size="md">
            <Modal.Header>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Icon name="wand-2" size="sm" /> Run a recipe
                </span>
            </Modal.Header>
            <Modal.Body>
                {recipes === null ? (
                    <Text size="sm" className="text-zinc-500">Loading recipes…</Text>
                ) : recipes.length === 0 ? (
                    <Text size="sm" className="text-zinc-500">No recipes available.</Text>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {recipes.map((r) => (
                            <button
                                key={r.launchId}
                                type="button"
                                onClick={() => setChosen(r)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 10,
                                    padding: '10px 12px',
                                    textAlign: 'left',
                                    borderRadius: 8,
                                    cursor: 'pointer',
                                    border: '1px solid var(--zinc-700)',
                                    background: 'transparent',
                                }}
                            >
                                <span style={{ display: 'flex', flexDirection: 'column' }}>
                                    <Text size="sm" style={{ fontWeight: 600 }}>{r.title}</Text>
                                    <Text size="xs" className="text-zinc-500">
                                        {r.source === 'plugin' ? `Plugin: ${r.pluginName ?? r.launchId}` : 'Built-in'}
                                    </Text>
                                </span>
                                <Icon name="arrow-right" size="sm" />
                            </button>
                        ))}
                    </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                    <Action variant="ghost" onClick={onClose}>Close</Action>
                </div>
            </Modal.Body>
        </Modal>
    );
}
