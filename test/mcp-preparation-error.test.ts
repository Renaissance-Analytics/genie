import { expect, it } from 'vitest';
import { McpPreparationError, mcpPreparationMessage } from '../src/main/mcp-preparation-error.js';

it('uses fixed words even if a typed preparation error message is overwritten', () => {
    const error = new McpPreparationError('offline'); error.message = 'synthetic-sensitive-error';
    const message = mcpPreparationMessage(error);
    expect(message.includes('Tynn could not be reached')).toBe(true);
    expect(message.includes('synthetic-sensitive-error')).toBe(false);
});

it('never exposes an arbitrary preparation exception message', () => {
    expect(mcpPreparationMessage(new Error('synthetic-sensitive-error')).includes('synthetic-sensitive-error')).toBe(false);
});
