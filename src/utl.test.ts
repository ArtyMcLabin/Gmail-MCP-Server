import { describe, it, expect } from 'vitest';
import { formatMessageId, formatReferences } from './utl.js';

describe('formatMessageId', () => {
  it('adds angle brackets if missing', () => {
    expect(formatMessageId('abc123@mail.com')).toBe('<abc123@mail.com>');
  });

  it('preserves existing angle brackets', () => {
    expect(formatMessageId('<abc123@mail.com>')).toBe('<abc123@mail.com>');
  });

  it('handles empty input', () => {
    expect(formatMessageId('')).toBe('<>');
  });

  it('trims whitespace before processing', () => {
    expect(formatMessageId('  abc123@mail.com  ')).toBe('<abc123@mail.com>');
  });

  it('trims whitespace and preserves existing brackets', () => {
    expect(formatMessageId('  <abc123@mail.com>  ')).toBe('<abc123@mail.com>');
  });

  it('handles message IDs with special characters', () => {
    expect(formatMessageId('CABx=+abc_123.test@mail.gmail.com')).toBe('<CABx=+abc_123.test@mail.gmail.com>');
  });

  it('handles Gmail-style message IDs', () => {
    const gmailId = 'CABx+4AQxdT_p8M0F=O3J+xyz@mail.gmail.com';
    expect(formatMessageId(gmailId)).toBe(`<${gmailId}>`);
  });
});

describe('formatReferences', () => {
  it('formats single message ID without brackets', () => {
    expect(formatReferences('abc@mail.com')).toBe('<abc@mail.com>');
  });

  it('formats single message ID with existing brackets', () => {
    expect(formatReferences('<abc@mail.com>')).toBe('<abc@mail.com>');
  });

  it('formats array of message IDs', () => {
    expect(formatReferences(['a@mail.com', 'b@mail.com'])).toBe('<a@mail.com> <b@mail.com>');
  });

  it('formats array with existing brackets', () => {
    expect(formatReferences(['<a@mail.com>', '<b@mail.com>'])).toBe('<a@mail.com> <b@mail.com>');
  });

  it('handles mixed array (some with brackets, some without)', () => {
    expect(formatReferences(['a@mail.com', '<b@mail.com>', 'c@mail.com'])).toBe('<a@mail.com> <b@mail.com> <c@mail.com>');
  });

  it('handles single-element array', () => {
    expect(formatReferences(['only@mail.com'])).toBe('<only@mail.com>');
  });

  it('handles empty array', () => {
    expect(formatReferences([])).toBe('');
  });

  it('handles long thread chains', () => {
    const chain = [
      'msg1@mail.com',
      'msg2@mail.com',
      'msg3@mail.com',
      'msg4@mail.com',
      'msg5@mail.com'
    ];
    expect(formatReferences(chain)).toBe('<msg1@mail.com> <msg2@mail.com> <msg3@mail.com> <msg4@mail.com> <msg5@mail.com>');
  });
});
