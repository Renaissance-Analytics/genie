import { describe, it, expect } from 'vitest';
import {
    AVAILABILITY_DEFAULT,
    parseScopeMap,
    scopeValue,
    setScopeEntry,
} from '../ftq-availability';

describe('AVAILABILITY_DEFAULT', () => {
    it('is Available (owner default)', () => {
        expect(AVAILABILITY_DEFAULT).toBe('available');
    });
});

describe('parseScopeMap', () => {
    it('parses a valid JSON map of known values', () => {
        expect(parseScopeMap('{"a":"dnd","b":"available"}')).toEqual({
            a: 'dnd',
            b: 'available',
        });
    });
    it('drops junk values but keeps the good keys', () => {
        expect(parseScopeMap('{"a":"dnd","b":"nope","c":5}')).toEqual({ a: 'dnd' });
    });
    it('is tolerant of non-JSON / empty / undefined / non-object → {}', () => {
        expect(parseScopeMap('not json')).toEqual({});
        expect(parseScopeMap('')).toEqual({});
        expect(parseScopeMap(undefined)).toEqual({});
        expect(parseScopeMap('[1,2]')).toEqual({}); // arrays are not scope maps
        expect(parseScopeMap('null')).toEqual({});
    });
});

describe('scopeValue', () => {
    it('returns the stored value, or undefined when unset (→ inherit)', () => {
        expect(scopeValue('{"a":"dnd"}', 'a')).toBe('dnd');
        expect(scopeValue('{"a":"dnd"}', 'b')).toBeUndefined();
        expect(scopeValue('', 'a')).toBeUndefined();
    });
});

describe('setScopeEntry', () => {
    it('adds a new entry, preserving the others', () => {
        expect(JSON.parse(setScopeEntry('{"a":"dnd"}', 'b', 'available'))).toEqual({
            a: 'dnd',
            b: 'available',
        });
    });
    it('overwrites an existing entry', () => {
        expect(JSON.parse(setScopeEntry('{"a":"dnd"}', 'a', 'available'))).toEqual({
            a: 'available',
        });
    });
    it('clears an entry with null, dropping just that key', () => {
        expect(JSON.parse(setScopeEntry('{"a":"dnd","b":"available"}', 'a', null))).toEqual({
            b: 'available',
        });
    });
    it('returns "" when the map is left empty, so the setting reads as unset', () => {
        expect(setScopeEntry('{"a":"dnd"}', 'a', null)).toBe('');
        expect(setScopeEntry('', 'x', null)).toBe('');
    });
    it('starts safely from junk input', () => {
        expect(JSON.parse(setScopeEntry('garbage', 'a', 'dnd'))).toEqual({ a: 'dnd' });
    });
});
