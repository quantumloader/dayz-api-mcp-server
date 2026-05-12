/**
 * Rules Module - Enforce Script Lexer Rules
 * Based on dfenscript
 */

// Enforce Script keywords - complete set of reserved words
export const keywords = new Set([
  // Class/type declaration keywords
  'class', 'enum', 'typedef', 'using', 'extends',
  // Modifiers
  'modded', 'proto', 'native', 'owned', 'local', 'auto', 'event', 'thread',
  'ref', 'reference', 'out', 'inout',
  'override', 'private', 'protected', 'public', 'static', 'const',
  'notnull', 'external', 'volatile', 'autoptr',
  // Control flow
  'return', 'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto',
  // Operators/values  
  'new', 'delete', 'null', 'true', 'false', 'this', 'super',
  // Types (common built-in)
  'void', 'int', 'float', 'bool', 'string', 'vector', 'typename',
  // Additional Enforce Script keywords
  'sealed', 'abstract', 'final'
]);

// Single-character punctuation
export const punct = '(){}[];:,.<>=+-*/%&|!?^~@#';

// Multi-character operators
export const multiCharOps = new Set([
  '==', '!=', '<=', '>=',
  '&&', '||',
  '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<', '>>',
  '->', '::',
  '??'
]);
