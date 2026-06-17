import React from 'react';
import { Action, Badge, Card, Heading, Icon, Text } from '@particle-academy/react-fancy';
import type { WorkspaceRow } from '../lib/genie';

interface Props {
    rows: WorkspaceRow[];
    onOpen: (id: string) => void;
    onRemove: (id: string) => void;
    onAdd: () => void;
}

export default function WorkspaceList({ rows, onOpen, onRemove, onAdd }: Props) {
    return (
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading as="h2" size="sm" style={{ margin: 0, flex: 1 }}>
                    Workspaces
                </Heading>
                <Action color="blue" size="sm" icon="plus" onClick={onAdd}>
                    Add workspace
                </Action>
            </div>

            {rows.length === 0 ? (
                <Card style={{ padding: 22, textAlign: 'center' }}>
                    <Icon
                        name="folder-plus"
                        size="lg"
                        className="text-zinc-400"
                        style={{ display: 'inline-block', marginBottom: 8 }}
                    />
                    <Text size="sm" className="text-zinc-500" style={{ display: 'block' }}>
                        No workspaces yet. Add an existing project folder, or
                        scaffold a new `.agi` envelope.
                    </Text>
                </Card>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {rows.map((w) => (
                        <Card
                            key={w.id}
                            style={{
                                padding: 12,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                            }}
                        >
                            <span
                                style={{
                                    width: 32,
                                    height: 32,
                                    borderRadius: 8,
                                    background: 'var(--bg-2)',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color:
                                        w.shape === 'agi'
                                            ? 'var(--amber-500)'
                                            : 'var(--blue-500)',
                                }}
                            >
                                <Icon
                                    name={w.shape === 'agi' ? 'box' : 'folder'}
                                    size="sm"
                                />
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Text
                                        size="sm"
                                        style={{
                                            fontWeight: 600,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {w.project_name ?? w.tynn_project_name}
                                    </Text>
                                    {w.shape === 'agi' && (
                                        <Badge color="amber" size="sm" variant="soft">
                                            .agi
                                        </Badge>
                                    )}
                                    {(w.backend ?? 'tynn') === 'aionima' && (
                                        <Badge color="emerald" size="sm" variant="soft">
                                            Aionima
                                        </Badge>
                                    )}
                                    {(w.backend ?? 'tynn') === 'tynn' && (
                                        <Badge color="blue" size="sm" variant="soft">
                                            Tynn
                                        </Badge>
                                    )}
                                </div>
                                <Text
                                    size="xs"
                                    className="text-zinc-500"
                                    style={{
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        fontFamily: 'var(--font-mono)',
                                    }}
                                    title={w.path}
                                >
                                    {w.path}
                                </Text>
                            </div>
                            <Action
                                color="blue"
                                size="sm"
                                icon="arrow-right"
                                onClick={() => onOpen(w.id)}
                                title="Open editor + terminal"
                            >
                                Open
                            </Action>
                            <Action
                                variant="ghost"
                                size="sm"
                                icon="trash-2"
                                onClick={() => {
                                    const name = w.project_name ?? w.tynn_project_name;
                                    if (
                                        confirm(
                                            `Remove "${name}" from Genie? The folder on disk is NOT deleted.`,
                                        )
                                    ) {
                                        onRemove(w.id);
                                    }
                                }}
                                title="Remove from Genie"
                            />
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
