import React from 'react';
import { Action, Heading, Text } from '@particle-academy/react-fancy';

interface Props {
    title: string;
    subtitle?: string;
    onOpenSettings?: () => void;
}

export default function Header({ title, subtitle, onOpenSettings }: Props) {
    return (
        <header className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-1)', background: 'var(--bg-1)' }}>
            <span
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg font-bold text-white"
                style={{ background: 'linear-gradient(135deg, var(--blue-500), var(--violet-500))' }}
            >
                G
            </span>
            <div className="min-w-0 flex-1">
                <Heading as="h1" size="md" className="m-0">
                    {title}
                </Heading>
                {subtitle && (
                    <Text size="xs" className="mt-0.5 block text-zinc-500">
                        {subtitle}
                    </Text>
                )}
            </div>
            {onOpenSettings && (
                <Action
                    variant="ghost"
                    size="sm"
                    icon="settings"
                    onClick={onOpenSettings}
                    title="Settings"
                />
            )}
        </header>
    );
}
