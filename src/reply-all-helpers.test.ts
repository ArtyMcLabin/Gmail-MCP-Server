import { describe, it, expect } from 'vitest';
import {
    parseEmailAddresses,
    filterOutEmail,
    addRePrefix,
    buildReferencesHeader,
    buildReplyAllRecipients
} from './reply-all-helpers.js';

describe('parseEmailAddresses', () => {
    it('extracts email from simple email address', () => {
        expect(parseEmailAddresses('user@example.com')).toEqual(['user@example.com']);
    });

    it('extracts email from "Name <email>" format', () => {
        expect(parseEmailAddresses('John Doe <john@example.com>')).toEqual(['john@example.com']);
    });

    it('handles multiple addresses separated by commas', () => {
        expect(parseEmailAddresses('alice@example.com, bob@example.com'))
            .toEqual(['alice@example.com', 'bob@example.com']);
    });

    it('handles mixed formats with multiple addresses', () => {
        expect(parseEmailAddresses('Alice <alice@example.com>, bob@example.com, Carol Smith <carol@example.com>'))
            .toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
    });

    it('handles empty string', () => {
        expect(parseEmailAddresses('')).toEqual([]);
    });

    it('handles whitespace around addresses', () => {
        expect(parseEmailAddresses('  user@example.com  ,  other@example.com  '))
            .toEqual(['user@example.com', 'other@example.com']);
    });

    it('handles angle brackets with spaces', () => {
        expect(parseEmailAddresses('Name < email@example.com >')).toEqual(['email@example.com']);
    });

    it('ignores entries without @ symbol', () => {
        expect(parseEmailAddresses('invalid, user@example.com')).toEqual(['user@example.com']);
    });
});

describe('filterOutEmail', () => {
    it('filters out matching email', () => {
        const emails = ['alice@example.com', 'bob@example.com', 'carol@example.com'];
        expect(filterOutEmail(emails, 'bob@example.com')).toEqual(['alice@example.com', 'carol@example.com']);
    });

    it('is case insensitive', () => {
        const emails = ['Alice@Example.com', 'bob@example.com'];
        expect(filterOutEmail(emails, 'alice@example.com')).toEqual(['bob@example.com']);
    });

    it('returns all emails if none match', () => {
        const emails = ['alice@example.com', 'bob@example.com'];
        expect(filterOutEmail(emails, 'carol@example.com')).toEqual(['alice@example.com', 'bob@example.com']);
    });

    it('handles empty array', () => {
        expect(filterOutEmail([], 'user@example.com')).toEqual([]);
    });

    it('handles empty filter email', () => {
        const emails = ['alice@example.com'];
        expect(filterOutEmail(emails, '')).toEqual(['alice@example.com']);
    });
});

describe('addRePrefix', () => {
    it('adds Re: prefix to subject without it', () => {
        expect(addRePrefix('Hello')).toBe('Re: Hello');
    });

    it('does not add Re: prefix if already present (lowercase)', () => {
        expect(addRePrefix('re: Hello')).toBe('re: Hello');
    });

    it('does not add Re: prefix if already present (uppercase)', () => {
        expect(addRePrefix('Re: Hello')).toBe('Re: Hello');
    });

    it('does not add Re: prefix if already present (mixed case)', () => {
        expect(addRePrefix('RE: Hello')).toBe('RE: Hello');
    });

    it('handles empty subject', () => {
        expect(addRePrefix('')).toBe('Re: ');
    });

    it('adds prefix when subject starts with similar but not Re:', () => {
        expect(addRePrefix('Regarding: Hello')).toBe('Re: Regarding: Hello');
    });
});

describe('buildReferencesHeader', () => {
    it('returns message ID when no original references', () => {
        expect(buildReferencesHeader('', '<msg123@example.com>')).toBe('<msg123@example.com>');
    });

    it('appends message ID to existing references', () => {
        expect(buildReferencesHeader('<ref1@example.com>', '<msg123@example.com>'))
            .toBe('<ref1@example.com> <msg123@example.com>');
    });

    it('returns empty string when both are empty', () => {
        expect(buildReferencesHeader('', '')).toBe('');
    });

    it('returns original references when message ID is empty', () => {
        expect(buildReferencesHeader('<ref1@example.com>', '')).toBe('<ref1@example.com>');
    });

    it('handles multiple existing references', () => {
        expect(buildReferencesHeader('<ref1@example.com> <ref2@example.com>', '<msg123@example.com>'))
            .toBe('<ref1@example.com> <ref2@example.com> <msg123@example.com>');
    });
});

describe('buildReplyAllRecipients', () => {
    const myEmail = 'me@example.com';

    it('puts original sender in To field', () => {
        const result = buildReplyAllRecipients(
            'sender@example.com',
            'me@example.com',
            '',
            myEmail
        );
        expect(result.to).toEqual(['sender@example.com']);
    });

    it('puts original To and CC in CC field', () => {
        const result = buildReplyAllRecipients(
            'sender@example.com',
            'recipient1@example.com, recipient2@example.com',
            'cc1@example.com',
            myEmail
        );
        expect(result.cc).toEqual(['recipient1@example.com', 'recipient2@example.com', 'cc1@example.com']);
    });

    it('excludes authenticated user from CC', () => {
        const result = buildReplyAllRecipients(
            'sender@example.com',
            'me@example.com, other@example.com',
            'me@example.com, another@example.com',
            myEmail
        );
        expect(result.cc).toEqual(['other@example.com', 'another@example.com']);
        expect(result.cc).not.toContain('me@example.com');
    });

    it('excludes authenticated user from To when sender is self', () => {
        const result = buildReplyAllRecipients(
            'me@example.com',
            'recipient@example.com',
            '',
            myEmail
        );
        expect(result.to).toEqual([]);
    });

    it('handles Name <email> format in From', () => {
        const result = buildReplyAllRecipients(
            'John Doe <john@example.com>',
            'me@example.com',
            '',
            myEmail
        );
        expect(result.to).toEqual(['john@example.com']);
    });

    it('handles complex scenario with mixed formats', () => {
        const result = buildReplyAllRecipients(
            'Alice <alice@example.com>',
            'Me <me@example.com>, Bob <bob@example.com>',
            'Carol <carol@example.com>, me@example.com',
            myEmail
        );
        expect(result.to).toEqual(['alice@example.com']);
        expect(result.cc).toEqual(['bob@example.com', 'carol@example.com']);
    });

    it('handles empty CC header', () => {
        const result = buildReplyAllRecipients(
            'sender@example.com',
            'recipient@example.com',
            '',
            myEmail
        );
        expect(result.cc).toEqual(['recipient@example.com']);
    });

    it('is case insensitive when excluding authenticated user', () => {
        const result = buildReplyAllRecipients(
            'sender@example.com',
            'ME@EXAMPLE.COM, other@example.com',
            '',
            myEmail
        );
        expect(result.cc).toEqual(['other@example.com']);
    });
});
