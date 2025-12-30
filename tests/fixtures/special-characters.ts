export const SQL_INJECTION_PAYLOADS = [
  { input: "'; DROP TABLE users; --", description: 'Classic SQL injection' },
  { input: "\\'; DROP TABLE users; --", description: 'Escaped quote injection' },
  { input: "1' OR '1'='1", description: 'Boolean injection' },
  { input: '1; SELECT * FROM users', description: 'Statement termination' },
  { input: "admin'--", description: 'Comment injection' },
  { input: "' UNION SELECT * FROM users --", description: 'UNION injection' },
  { input: "'); DELETE FROM users; --", description: 'Parenthesis injection' },
  { input: "' OR 1=1 #", description: 'MySQL comment injection' },
  { input: "1' AND SLEEP(5) #", description: 'Time-based injection' },
  { input: '"\'; DROP TABLE users; --', description: 'Mixed quotes injection' },
  { input: 'name\nDROP TABLE users', description: 'Newline injection' },
  { input: "' OR ''='", description: 'Empty string comparison' },
  { input: '${injection}', description: 'Template literal injection' },
  { input: '{{injection}}', description: 'Template syntax injection' },
  { input: "Robert'); DROP TABLE Students;--", description: 'Bobby Tables' },
];

export const UNICODE_EDGE_CASES = [
  { char: '\u0000', name: 'NULL byte' },
  { char: '\u2028', name: 'Line separator' },
  { char: '\u2029', name: 'Paragraph separator' },
  { char: '\u001B', name: 'Escape character' },
  { char: '\uFEFF', name: 'BOM' },
  { char: '\u200B', name: 'Zero-width space' },
  { char: '\u202E', name: 'Right-to-left override' },
  { char: '𝕋𝕖𝕤𝕥', name: 'Mathematical alphanumeric symbols' },
  { char: '测试', name: 'Chinese characters' },
  { char: 'тест', name: 'Cyrillic characters' },
  { char: 'اختبار', name: 'Arabic characters' },
  { char: '🎉', name: 'Emoji' },
];

export const SPECIAL_SQL_CHARACTERS = [
  { char: "'", name: 'Single quote' },
  { char: '"', name: 'Double quote' },
  { char: '`', name: 'Backtick' },
  { char: ';', name: 'Semicolon' },
  { char: '--', name: 'SQL comment start' },
  { char: '/*', name: 'Block comment start' },
  { char: '*/', name: 'Block comment end' },
  { char: '\\', name: 'Backslash' },
  { char: '%', name: 'Percent (LIKE wildcard)' },
  { char: '_', name: 'Underscore (LIKE wildcard)' },
  { char: '\t', name: 'Tab' },
  { char: '\r', name: 'Carriage return' },
  { char: '\n', name: 'Newline' },
];

export const LARGE_DATASET_GENERATORS = {
  generateIds: (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1),

  generateStrings: (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `item_${i}`),

  generateRows: (count: number): Array<{ name: string; email: string }> =>
    Array.from({ length: count }, (_, i) => ({
      name: `User ${i}`,
      email: `user${i}@example.com`,
    })),

  generateRowsWithId: (count: number): Array<{ id: number; name: string; value: number }> =>
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `Item ${i}`,
      value: Math.floor(Math.random() * 1000),
    })),
};

export const BOUNDARY_VALUES = {
  integers: {
    maxInt32: 2147483647,
    minInt32: -2147483648,
    maxBigInt: BigInt('9223372036854775807'),
    minBigInt: BigInt('-9223372036854775808'),
    zero: 0,
    negativeOne: -1,
  },
  strings: {
    empty: '',
    singleChar: 'a',
    maxLength: 'a'.repeat(10000),
    whitespaceOnly: '   ',
    unicode: '🎉🔥💯',
  },
  arrays: {
    empty: [] as unknown[],
    single: [1],
    large: Array.from({ length: 1000 }, (_, i) => i),
  },
};
