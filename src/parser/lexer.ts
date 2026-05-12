/**
 * Lexer Module - Enforce Script
 * Based on dfenscript (https://github.com/ApertureScienceInnovators/dfenscript)
 * Adapted for MCP server usage (no vscode-languageserver dependency)
 */

import { Token, TokenKind } from './token.js';
import { keywords, punct, multiCharOps } from './rules.js';

/**
 * Skip over a preprocessor-disabled region, handling nested #ifdef/#endif
 */
function skipPreprocRegion(text: string, pos: number, stopAtElse: boolean): number {
    let i = pos;
    let depth = 1;

    while (depth > 0 && i < text.length) {
        while (i < text.length && text[i] !== '#') {
            if (text[i] === '"' || text[i] === "'") {
                const quote = text[i];
                i++;
                while (i < text.length && text[i] !== quote) {
                    if (text[i] === '\\' && i + 1 < text.length) i++;
                    i++;
                }
                if (i < text.length) i++;
            } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '/') {
                while (i < text.length && text[i] !== '\n') i++;
            } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
                i += 2;
                while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
                if (i + 1 < text.length) i += 2;
            } else {
                i++;
            }
        }

        if (i >= text.length) break;

        const dStart = i;
        while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
        const d = text.slice(dStart, i).trim();

        if (d.match(/^#\s*(ifdef|ifndef)\b/)) {
            depth++;
        } else if (d.match(/^#\s*endif\b/)) {
            depth--;
        } else if (stopAtElse && depth === 1 && d.match(/^#\s*(else|elif)\b/)) {
            depth = 0;
        }
    }

    return i;
}

export function lex(text: string, defines?: Set<string>): Token[] {
    const toks: Token[] = [];
    let i = 0;

    const push = (kind: TokenKind, value: string, start: number) => {
        toks.push({ kind, value, start, end: i });
    };

    while (i < text.length) {
        const ch = text[i];
        const start = i;

        // whitespace
        if (/\s/.test(ch)) {
            i++;
            continue;
        }

        // single line comment
        if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
            i += 2;
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
            push(TokenKind.Comment, text.slice(start, i), start);
            continue;
        }

        // multi line comment
        if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            push(TokenKind.Comment, text.slice(start, i), start);
            continue;
        }

        // preprocessor
        if (ch === '#') {
            const lineStart = i;
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
            const directive = text.slice(lineStart, i).trim();

            const ifdefMatch = directive.match(/^#\s*(ifdef|ifndef)\s+(\w+)/);
            if (ifdefMatch) {
                const isIfdef = ifdefMatch[1] === 'ifdef';
                const symbol = ifdefMatch[2];
                const isDefined = defines?.has(symbol) ?? false;
                const processFirstBranch = isIfdef ? isDefined : !isDefined;

                if (processFirstBranch) {
                    push(TokenKind.Preproc, directive, lineStart);
                    continue;
                } else {
                    i = skipPreprocRegion(text, i, true);
                    push(TokenKind.Preproc, text.slice(lineStart, i), lineStart);
                    continue;
                }
            }

            if (directive.match(/^#\s*else\b/)) {
                const elseStart = lineStart;
                i = skipPreprocRegion(text, i, false);
                push(TokenKind.Preproc, text.slice(elseStart, i), elseStart);
                continue;
            }

            if (directive.match(/^#\s*endif\b/)) {
                push(TokenKind.Preproc, directive, lineStart);
                continue;
            }

            push(TokenKind.Preproc, directive, lineStart);
            continue;
        }

        // string literal "..."
        if (ch === '"') {
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < text.length) i += 2;
                else i++;
            }
            i++;
            push(TokenKind.String, text.slice(start, i), start);
            continue;
        }

        // char literal '...'
        if (ch === "'") {
            i++;
            while (i < text.length && text[i] !== "'") {
                if (text[i] === '\\' && i + 1 < text.length) i += 2;
                else i++;
            }
            i++;
            push(TokenKind.String, text.slice(start, i), start);
            continue;
        }

        // number literal
        if (/\d/.test(ch) || (ch === '.' && i + 1 < text.length && /\d/.test(text[i + 1]))) {
            if (ch === '0' && i + 1 < text.length && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
                i += 2;
                while (i < text.length && /[0-9a-fA-F]/.test(text[i])) i++;
            } else {
                while (i < text.length && /[0-9.]/.test(text[i])) i++;
                if (i < text.length && (text[i] === 'e' || text[i] === 'E')) {
                    i++;
                    if (i < text.length && (text[i] === '+' || text[i] === '-')) i++;
                    while (i < text.length && /\d/.test(text[i])) i++;
                }
                if (i < text.length && (text[i] === 'f' || text[i] === 'F')) i++;
            }
            push(TokenKind.Number, text.slice(start, i), start);
            continue;
        }

        // identifier / keyword
        if (/[_A-Za-z]/.test(ch)) {
            while (i < text.length && /[_0-9A-Za-z]/.test(text[i])) i++;
            const value = text.slice(start, i);
            const kind = keywords.has(value) ? TokenKind.Keyword : TokenKind.Identifier;
            push(kind, value, start);
            continue;
        }

        // multi-character operators
        if (i + 1 < text.length) {
            const twoChar = ch + text[i + 1];
            if (multiCharOps.has(twoChar)) {
                i += 2;
                push(TokenKind.Operator, twoChar, start);
                continue;
            }
        }

        // single-character punctuation
        if (punct.includes(ch)) {
            i++;
            push(TokenKind.Punctuation, ch, start);
            continue;
        }

        // single-character operators
        if ('+-*/%&|!^~<>='.includes(ch)) {
            i++;
            push(TokenKind.Operator, ch, start);
            continue;
        }

        // unknown
        i++;
        push(TokenKind.Operator, ch, start);
    }

    push(TokenKind.EOF, '', i);
    return toks;
}
