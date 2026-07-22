import { useMemo, useState, useSyncExternalStore } from 'react';
import { Action, Carousel, Icon, Modal, Text, useCarousel } from '@particle-academy/react-fancy';
import { api } from '../../lib/genie';
import { RecipeEngine, type Recipe } from '../../lib/recipes';
import { StepView } from './steps';

interface Props {
    recipe: Recipe;
    /** Workspace the recipe runs against (scopes tasks + remote terminals). */
    workspaceId?: string;
    /** Headless host the terminal steps run on, when remote. */
    workstationId?: string;
    /** Fallback cwd for terminal steps without an explicit `cwd`. */
    defaultCwd?: string;
    /** Fired after onComplete resolves. */
    onDone?: () => void;
    onClose: () => void;
}

/**
 * WizardModal — the reusable stepped-modal that runs a Recipe. It composes
 * react-fancy `Modal` + `Carousel` (wizard variant) exactly like
 * InteractiveUpgradeWizard, but the steps and their gating come entirely from a
 * `RecipeEngine`, so any recipe (built-in or plugin-contributed) drives it
 * without bespoke UI. Rendering is the WizardModal's job; effects belong to the
 * per-type step views in `steps.tsx`.
 */
export default function WizardModal({
    recipe,
    workspaceId,
    workstationId,
    defaultCwd = '.',
    onDone,
    onClose,
}: Props) {
    const engine = useMemo(
        () => new RecipeEngine(recipe, { workspaceId, workstationId }),
        [recipe, workspaceId, workstationId],
    );
    // The context is stable for the engine's lifetime and backed by its store.
    const ctx = useMemo(() => engine.buildContext(api), [engine]);
    // Re-render whenever the engine mutates (step state, data, index).
    useSyncExternalStore(
        (cb) => engine.subscribe(cb),
        () => engine.getSnapshot(),
    );

    const [finishing, setFinishing] = useState(false);

    const finish = async () => {
        if (finishing || !engine.canAdvance() || !engine.isLastStep) return;
        setFinishing(true);
        try {
            await recipe.onComplete?.(ctx);
            engine.complete();
            onDone?.();
            onClose();
        } catch (e) {
            engine.markError(engine.index, e instanceof Error ? e.message : String(e));
        } finally {
            setFinishing(false);
        }
    };

    return (
        <Modal open onClose={onClose} size="xl">
            <Modal.Header>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Icon name="wand-2" size="sm" /> {recipe.title}
                </span>
            </Modal.Header>
            <Modal.Body>
                <Carousel
                    variant="wizard"
                    activeIndex={engine.index}
                    onIndexChange={(i) => engine.goTo(i)}
                    onFinish={() => void finish()}
                >
                    <Carousel.Steps />
                    <Carousel.Panels transition="fade">
                        {recipe.steps.map((step, i) => (
                            <Carousel.Slide key={step.id} name={step.title}>
                                <StepView
                                    step={step}
                                    engine={engine}
                                    ctx={ctx}
                                    active={engine.index === i}
                                    defaultCwd={defaultCwd}
                                />
                            </Carousel.Slide>
                        ))}
                    </Carousel.Panels>
                    <WizardFooter
                        onCancel={onClose}
                        canAdvance={engine.canAdvance()}
                        isLast={engine.isLastStep}
                        finishing={finishing}
                        onFinish={() => void finish()}
                    />
                </Carousel>
            </Modal.Body>
        </Modal>
    );
}

/**
 * Footer controls — Back (always available except on step 0), Next (gated on
 * the engine's forward rule) and Finish (last step, once satisfied). Lives
 * inside the Carousel so useCarousel() reaches its context, mirroring
 * InteractiveUpgradeWizard's WizardFooter.
 */
function WizardFooter({
    onCancel,
    canAdvance,
    isLast,
    finishing,
    onFinish,
}: {
    onCancel: () => void;
    canAdvance: boolean;
    isLast: boolean;
    finishing: boolean;
    onFinish: () => void;
}) {
    const { activeIndex, next, prev } = useCarousel();
    const isFirst = activeIndex === 0;

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <Action variant="ghost" onClick={onCancel} disabled={finishing}>
                Cancel
            </Action>
            <span style={{ flex: 1 }} />
            {!isFirst && (
                <Action variant="ghost" icon="arrow-left" onClick={prev} disabled={finishing}>
                    Back
                </Action>
            )}
            {isLast ? (
                <Action color="blue" icon="check" onClick={onFinish} disabled={!canAdvance || finishing}>
                    {finishing ? 'Finishing…' : 'Finish'}
                </Action>
            ) : (
                <Action color="blue" iconTrailing="arrow-right" onClick={next} disabled={!canAdvance}>
                    Next
                </Action>
            )}
        </div>
    );
}
