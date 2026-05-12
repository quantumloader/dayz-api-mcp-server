import * as fs from 'fs';
import {
  ParsedFile,
  ParsedClass,
  ParsedMethod,
  ParsedParameter,
  ParsedVariable,
  ParsedEnum,
  ParsedEnumValue,
  ScriptLayer
} from '../types/index.js';
import { Token, TokenKind } from './token.js';
import { lex } from './lexer.js';

const MODIFIERS = new Set([
  'override', 'proto', 'native', 'owned', 'ref', 'reference',
  'public', 'private', 'protected', 'static', 'const',
  'out', 'inout', 'notnull', 'external', 'volatile',
  'local', 'autoptr', 'event', 'sealed', 'abstract', 'final', 'thread'
]);

const PRIMITIVE_TYPES = new Set([
  'void', 'int', 'float', 'bool', 'string', 'vector', 'typename', 'auto'
]);

const CONTROL_FLOW = new Set([
  'if', 'else', 'while', 'for', 'foreach', 'do', 'switch',
  'case', 'default', 'return', 'break', 'continue', 'goto'
]);

export class EnforceScriptParser {
  private toks: Token[] = [];
  private pos: number = 0;
  private text: string = '';
  private currentFile: string = '';

  parseFile(filePath: string): ParsedFile {
    const content = fs.readFileSync(filePath, 'utf-8');
    return this.parseString(content, filePath);
  }

  parseString(content: string, filePath: string = '<unknown>'): ParsedFile {
    this.currentFile = filePath;
    this.text = content;
    this.toks = lex(content);
    this.pos = 0;

    const classes: ParsedClass[] = [];
    const enums: ParsedEnum[] = [];
    const globalFunctions: ParsedMethod[] = [];

    while (!this.eof()) {
      if (this.peekVal() === ';') { this.next(); continue; }

      try {
        const result = this.parseTopLevel();
        if (!result) { this.next(); continue; }
        if (result.kind === 'class') classes.push(result.data as ParsedClass);
        else if (result.kind === 'enum') enums.push(result.data as ParsedEnum);
        else if (result.kind === 'function') globalFunctions.push(result.data as ParsedMethod);
      } catch {
        this.recoverToNextDecl();
      }
    }

    return {
      path: filePath,
      layer: this.detectLayer(filePath),
      classes,
      enums,
      globalFunctions,
      imports: this.extractImports(content)
    };
  }

  // ── Token helpers ──────────────────────────────────────────

  private skipTrivia(): void {
    while (this.pos < this.toks.length &&
      (this.toks[this.pos].kind === TokenKind.Comment ||
       this.toks[this.pos].kind === TokenKind.Preproc)) {
      this.pos++;
    }
  }

  private peek(): Token {
    this.skipTrivia();
    if (this.pos >= this.toks.length) return { kind: TokenKind.EOF, value: '', start: this.text.length, end: this.text.length };
    return this.toks[this.pos];
  }

  private peekVal(): string {
    return this.peek().value;
  }

  private next(): Token {
    this.skipTrivia();
    if (this.pos >= this.toks.length) return { kind: TokenKind.EOF, value: '', start: this.text.length, end: this.text.length };
    return this.toks[this.pos++];
  }

  private eof(): boolean {
    this.skipTrivia();
    return this.peek().kind === TokenKind.EOF;
  }

  private expect(val: string): Token {
    const t = this.next();
    if (t.value !== val) {
      throw new Error(`Expected '${val}', got '${t.value}' at offset ${t.start}`);
    }
    return t;
  }

  private isModifier(t: Token): boolean {
    return t.kind === TokenKind.Keyword && MODIFIERS.has(t.value);
  }

  private isTypeToken(t: Token): boolean {
    return t.kind === TokenKind.Identifier ||
      (t.kind === TokenKind.Keyword && PRIMITIVE_TYPES.has(t.value));
  }

  private lineAt(offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < this.text.length; i++) {
      if (this.text[i] === '\n') line++;
    }
    return line;
  }

  private textSlice(startOffset: number, endOffset: number): string {
    return this.text.slice(startOffset, endOffset);
  }

  private recoverToNextDecl(): void {
    let depth = 0;
    let skipped = 0;
    while (!this.eof() && skipped < 500) {
      const v = this.peekVal();
      if (v === '{') { depth++; this.next(); }
      else if (v === '}') {
        if (depth === 0) { this.next(); break; }
        depth--; this.next();
        if (depth === 0) break;
      }
      else if (v === ';' && depth === 0) { this.next(); break; }
      else { this.next(); }
      skipped++;
    }
  }

  // ── Extract comment above a position ──────────────────────

  private extractCommentBefore(offset: number): string | undefined {
    // Look backwards through tokens for a comment just before this position
    let idx = this.pos - 1;
    while (idx >= 0) {
      const t = this.toks[idx];
      if (t.kind === TokenKind.Comment) {
        const val = t.value.trim();
        if (val.startsWith('//')) return val.slice(2).trim();
        if (val.startsWith('/*')) return val.slice(2, -2).trim();
        return val;
      }
      if (t.kind === TokenKind.Preproc) { idx--; continue; }
      break;
    }
    return undefined;
  }

  // ── Top-level parsing ─────────────────────────────────────

  private parseTopLevel(): { kind: 'class' | 'enum' | 'function'; data: unknown } | null {
    const mods = this.collectModifiers();
    if (this.eof()) return null;

    const t = this.peek();

    // class / modded class
    if (t.value === 'class') {
      return { kind: 'class', data: this.parseClass(mods, false) };
    }

    // enum
    if (t.value === 'enum') {
      return { kind: 'enum', data: this.parseEnum() };
    }

    // typedef — skip
    if (t.value === 'typedef') {
      while (!this.eof() && this.peekVal() !== ';') this.next();
      if (!this.eof()) this.next();
      return null;
    }

    // Statement keywords at top level — skip
    if (t.kind === TokenKind.Keyword && CONTROL_FLOW.has(t.value)) {
      this.recoverToNextDecl();
      return null;
    }

    // Try function or variable
    return this.parseFuncOrVar(mods);
  }

  private collectModifiers(): string[] {
    const mods: string[] = [];
    while (!this.eof() && this.isModifier(this.peek())) {
      mods.push(this.next().value);
    }
    // Also handle 'modded' before 'class'
    if (!this.eof() && this.peek().value === 'modded') {
      mods.push(this.next().value);
    }
    return mods;
  }

  // ── Enum parsing ──────────────────────────────────────────

  private parseEnum(): ParsedEnum {
    const startTok = this.next(); // consume 'enum'
    const nameTok = this.next();
    const name = nameTok.value;

    // optional base: enum Foo : int
    if (this.peekVal() === ':' || this.peekVal() === 'extends') {
      this.next();
      this.next(); // base type
    }

    this.expect('{');
    const values: ParsedEnumValue[] = [];
    let enumIdx = 0;

    while (!this.eof() && this.peekVal() !== '}') {
      if (this.peek().kind === TokenKind.Identifier || this.peek().kind === TokenKind.Keyword) {
        const valName = this.next().value;
        let valNum: number | undefined;
        if (this.peekVal() === '=') {
          this.next();
          // skip expression until , or }
          const numTok = this.peek();
          if (numTok.kind === TokenKind.Number) {
            valNum = parseInt(this.next().value);
            enumIdx = valNum + 1;
          } else {
            // complex expression — skip to , or }
            while (!this.eof() && this.peekVal() !== ',' && this.peekVal() !== '}') this.next();
          }
        } else {
          valNum = enumIdx++;
        }
        values.push({ name: valName, value: valNum });
      }
      if (this.peekVal() === ',') this.next();
      else if (this.peekVal() !== '}') this.next(); // skip unexpected
    }
    this.expect('}');

    return {
      name,
      file: this.currentFile,
      line: this.lineAt(startTok.start),
      values,
      description: this.extractCommentBefore(startTok.start)
    };
  }

  // ── Class parsing ─────────────────────────────────────────

  private parseClass(outerMods: string[], _nested: boolean): ParsedClass {
    const startTok = this.next(); // consume 'class'
    const nameTok = this.next();
    const name = nameTok.value;

    // Generic: class Foo<Class T>
    if (this.peekVal() === '<') {
      this.next();
      let depth = 1;
      while (!this.eof() && depth > 0) {
        const v = this.peekVal();
        if (v === '<') depth++;
        else if (v === '>') depth--;
        else if (v === '>>') depth -= 2;
        this.next();
      }
    }

    // Inheritance: extends / :
    let parent: string | undefined;
    if (this.peekVal() === ':' || this.peekVal() === 'extends') {
      this.next();
      parent = this.parseTypeString();
    }

    this.expect('{');

    const methods: ParsedMethod[] = [];
    const variables: ParsedVariable[] = [];

    while (!this.eof() && this.peekVal() !== '}') {
      if (this.peekVal() === ';') { this.next(); continue; }

      try {
        this.parseClassMember(name, methods, variables);
      } catch {
        // Error recovery: skip to next member boundary
        let d = 0;
        while (!this.eof()) {
          const v = this.peekVal();
          if (v === '{') { d++; this.next(); }
          else if (v === '}') {
            if (d === 0) break;
            d--; this.next();
            if (d === 0) break;
          }
          else if (v === ';' && d === 0) { this.next(); break; }
          else this.next();
        }
      }
    }
    if (this.peekVal() === '}') this.next();

    return {
      name,
      file: this.currentFile,
      line: this.lineAt(startTok.start),
      parent,
      isModded: outerMods.includes('modded'),
      isAbstract: outerMods.includes('abstract'),
      isSealed: outerMods.includes('sealed'),
      methods,
      variables,
      description: this.extractCommentBefore(startTok.start)
    };
  }

  private parseClassMember(className: string, methods: ParsedMethod[], variables: ParsedVariable[]): void {
    const mods = this.collectModifiers();
    if (this.eof() || this.peekVal() === '}') return;

    // Nested class
    if (this.peekVal() === 'class') {
      // Skip nested class entirely
      this.next(); // 'class'
      this.next(); // name
      if (this.peekVal() === '<') { this.skipGenericParams(); }
      if (this.peekVal() === ':' || this.peekVal() === 'extends') { this.next(); this.parseTypeString(); }
      if (this.peekVal() === '{') { this.skipBraceBlock(); }
      return;
    }

    // Nested enum
    if (this.peekVal() === 'enum') {
      this.parseEnum(); // parse and discard (nested enums inside classes)
      return;
    }

    // typedef inside class
    if (this.peekVal() === 'typedef') {
      while (!this.eof() && this.peekVal() !== ';') this.next();
      if (!this.eof()) this.next();
      return;
    }

    // Control flow at class level — skip
    if (this.peek().kind === TokenKind.Keyword && CONTROL_FLOW.has(this.peekVal())) {
      this.recoverToNextDecl();
      return;
    }

    // Destructor: ~ClassName
    if (this.peekVal() === '~') {
      const startOff = this.peek().start;
      this.next(); // ~
      const dName = this.next(); // name
      const method = this.parseMethodAfterName(
        '~' + dName.value, 'void', mods, startOff, className
      );
      if (method) methods.push(method);
      return;
    }

    // Need type token
    if (!this.isTypeToken(this.peek())) {
      this.next(); // skip unexpected
      return;
    }

    const typeTok = this.next();
    const typeStr = typeTok.value;

    // Constructor: ClassName(
    if (typeStr === className && this.peekVal() === '(') {
      const method = this.parseMethodAfterName(className, className, mods, typeTok.start, className);
      if (method) methods.push(method);
      return;
    }

    // Type might be generic: array<int>
    let fullType = typeStr;
    if (this.peekVal() === '<') {
      const genStart = this.pos;
      this.skipGenericParams();
      fullType += this.textSlice(this.toks[genStart].start, this.toks[this.pos - 1]?.end || this.toks[genStart].end);
    }

    // Need identifier after type
    if (!this.isTypeToken(this.peek()) && this.peek().kind !== TokenKind.Identifier) {
      // Could be just a semicolon after type (e.g., forward decl)
      if (this.peekVal() === ';') { this.next(); return; }
      this.next();
      return;
    }

    const nameTok = this.next();

    // Function: name(
    if (this.peekVal() === '(') {
      const method = this.parseMethodAfterName(nameTok.value, fullType, mods, typeTok.start, className);
      if (method) methods.push(method);
      return;
    }

    // Variable: name; or name = ...;  or name, name2;
    const variable = this.parseVariableAfterName(nameTok.value, fullType, mods, typeTok.start);
    if (variable) variables.push(variable);

    // Handle comma-separated variables: int a, b, c;
    while (this.peekVal() === ',') {
      this.next(); // consume ','
      if (this.peek().kind === TokenKind.Identifier || this.isTypeToken(this.peek())) {
        const nextName = this.next();
        const v2 = this.parseVariableAfterName(nextName.value, fullType, mods, typeTok.start);
        if (v2) variables.push(v2);
      }
    }

    if (this.peekVal() === ';') this.next();
  }

  // ── Method parsing ────────────────────────────────────────

  private parseMethodAfterName(
    name: string, returnType: string, mods: string[],
    startOffset: number, className: string | null
  ): ParsedMethod | null {
    const params = this.parseParamList();
    const description = this.extractCommentBefore(startOffset);

    // Build signature
    const modStr = mods.filter(m => m !== 'modded').join(' ');
    const paramStr = params.map(p => {
      let s = '';
      if (p.isOut) s += 'out ';
      if (p.isRef) s += 'ref ';
      s += p.type + ' ' + p.name;
      if (p.defaultValue) s += ' = ' + p.defaultValue;
      return s;
    }).join(', ');
    const signature = `${modStr ? modStr + ' ' : ''}${returnType} ${name}(${paramStr})`.trim();

    // Body
    let body: string | undefined;
    if (this.peekVal() === '{') {
      const bodyStart = this.peek().start;
      this.skipBraceBlock();
      const bodyEnd = this.toks[this.pos - 1]?.end || bodyStart;
      body = this.textSlice(bodyStart, bodyEnd);
    } else {
      // proto / native / abstract — no body, ends with ;
      if (this.peekVal() === ';') this.next();
    }

    return {
      name,
      signature,
      returnType,
      parameters: params,
      isPrivate: mods.includes('private'),
      isProtected: mods.includes('protected'),
      isStatic: mods.includes('static'),
      isOverride: mods.includes('override'),
      isEvent: mods.includes('event'),
      isAbstract: mods.includes('abstract') || mods.includes('proto') || mods.includes('native'),
      description,
      line: this.lineAt(startOffset),
      body
    };
  }

  private parseParamList(): ParsedParameter[] {
    this.expect('(');
    const params: ParsedParameter[] = [];

    while (!this.eof() && this.peekVal() !== ')') {
      const p = this.parseOneParam();
      if (p) params.push(p);
      if (this.peekVal() === ',') this.next();
    }

    if (this.peekVal() === ')') this.next();
    return params;
  }

  private parseOneParam(): ParsedParameter | null {
    const pMods: string[] = [];
    while (!this.eof() && this.isModifier(this.peek())) {
      pMods.push(this.next().value);
    }

    if (this.eof() || this.peekVal() === ')' || this.peekVal() === ',') return null;

    const typeTok = this.next();
    let typeStr = typeTok.value;

    // generic type
    if (this.peekVal() === '<') {
      const gStart = this.pos;
      this.skipGenericParams();
      typeStr += this.textSlice(this.toks[gStart].start, this.toks[this.pos - 1]?.end || this.toks[gStart].end);
    }

    // array type: int[]
    while (this.peekVal() === '[') {
      this.next(); // [
      if (this.peekVal() !== ']') this.next(); // size
      this.expect(']');
      typeStr += '[]';
    }

    if (this.eof() || this.peekVal() === ')' || this.peekVal() === ',') {
      // Type without name — edge case
      return { name: typeStr, type: 'auto', isOut: pMods.includes('out'), isRef: pMods.includes('ref') };
    }

    const nameTok = this.next();
    // array after name: int arr[]
    while (this.peekVal() === '[') {
      this.next();
      if (this.peekVal() !== ']') this.next();
      this.expect(']');
      typeStr += '[]';
    }

    let defaultValue: string | undefined;
    if (this.peekVal() === '=') {
      this.next();
      const parts: string[] = [];
      let depth = 0;
      while (!this.eof()) {
        const v = this.peekVal();
        if (v === '(' || v === '{' || v === '[') depth++;
        if (v === ')' || v === '}' || v === ']') {
          if (depth === 0) break;
          depth--;
        }
        if (v === ',' && depth === 0) break;
        parts.push(this.next().value);
      }
      defaultValue = parts.join(' ');
    }

    return {
      name: nameTok.value,
      type: typeStr,
      isOut: pMods.includes('out'),
      isRef: pMods.includes('ref') || pMods.includes('notnull'),
      defaultValue
    };
  }

  // ── Variable parsing ──────────────────────────────────────

  private parseVariableAfterName(
    name: string, type: string, mods: string[], startOffset: number
  ): ParsedVariable | null {
    let defaultValue: string | undefined;

    // array dims after name
    while (this.peekVal() === '[') {
      this.next();
      if (this.peekVal() !== ']') this.next();
      this.expect(']');
      type += '[]';
    }

    if (this.peekVal() === '=') {
      this.next();
      const parts: string[] = [];
      let depth = 0;
      while (!this.eof()) {
        const v = this.peekVal();
        if (v === '{' || v === '(' || v === '[') depth++;
        if (v === '}' || v === ')' || v === ']') {
          if (depth === 0) break;
          depth--;
        }
        if ((v === ';' || v === ',') && depth === 0) break;
        parts.push(this.next().value);
      }
      defaultValue = parts.join(' ');
    }

    return {
      name,
      type,
      isPrivate: mods.includes('private'),
      isProtected: mods.includes('protected'),
      isStatic: mods.includes('static'),
      isConst: mods.includes('const'),
      defaultValue,
      line: this.lineAt(startOffset)
    };
  }

  // ── Global function or variable ───────────────────────────

  private parseFuncOrVar(mods: string[]): { kind: 'function'; data: ParsedMethod } | null {
    if (!this.isTypeToken(this.peek())) {
      // Skip to next decl boundary
      this.recoverToNextDecl();
      return null;
    }

    const typeTok = this.next();
    let typeStr = typeTok.value;

    // generic type
    if (this.peekVal() === '<') {
      const gStart = this.pos;
      this.skipGenericParams();
      typeStr += this.textSlice(this.toks[gStart].start, this.toks[this.pos - 1]?.end || this.toks[gStart].end);
    }

    if (this.eof() || this.peekVal() === ';') {
      if (!this.eof()) this.next();
      return null;
    }

    // Need name
    if (!this.isTypeToken(this.peek()) && this.peek().kind !== TokenKind.Identifier) {
      this.recoverToNextDecl();
      return null;
    }

    const nameTok = this.next();

    if (this.peekVal() === '(') {
      const method = this.parseMethodAfterName(nameTok.value, typeStr, mods, typeTok.start, null);
      if (method) return { kind: 'function', data: method };
    }

    // global variable — skip
    while (!this.eof() && this.peekVal() !== ';') this.next();
    if (!this.eof()) this.next();
    return null;
  }

  // ── Type string parsing ───────────────────────────────────

  private parseTypeString(): string {
    // Skip modifiers before type
    while (!this.eof() && this.isModifier(this.peek())) this.next();

    if (this.eof()) return 'void';
    const t = this.next();
    let s = t.value;

    // generic
    if (this.peekVal() === '<') {
      const gStart = this.pos;
      this.skipGenericParams();
      s += this.textSlice(this.toks[gStart].start, this.toks[this.pos - 1]?.end || this.toks[gStart].end);
    }

    return s;
  }

  // ── Utility ───────────────────────────────────────────────

  private skipBraceBlock(): void {
    if (this.peekVal() !== '{') return;
    this.next(); // {
    let depth = 1;
    while (!this.eof() && depth > 0) {
      const v = this.next().value;
      if (v === '{') depth++;
      else if (v === '}') depth--;
    }
  }

  private skipGenericParams(): void {
    if (this.peekVal() !== '<') return;
    this.next(); // <
    let depth = 1;
    while (!this.eof() && depth > 0) {
      const v = this.peekVal();
      if (v === '<') depth++;
      else if (v === '>') depth--;
      else if (v === '>>') depth -= 2;
      this.next();
    }
  }

  private detectLayer(filePath: string): ScriptLayer {
    if (filePath.includes('1_Core')) return '1_Core';
    if (filePath.includes('2_GameLib')) return '2_GameLib';
    if (filePath.includes('3_Game')) return '3_Game';
    if (filePath.includes('4_World')) return '4_World';
    if (filePath.includes('5_Mission')) return '5_Mission';
    return 'Unknown';
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const moddedRegex = /modded\s+class\s+(\w+)/g;
    let match;
    while ((match = moddedRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    return imports;
  }
}
