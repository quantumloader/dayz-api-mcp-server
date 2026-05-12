// Основные типы данных для Enforce Script

export interface ParsedParameter {
  name: string;
  type: string;
  isRef?: boolean;
  isOut?: boolean;
  defaultValue?: string;
}

export interface ParsedMethod {
  name: string;
  signature: string;
  returnType: string;
  parameters: ParsedParameter[];
  isPrivate: boolean;
  isProtected: boolean;
  isStatic: boolean;
  isOverride: boolean;
  isEvent: boolean;
  isAbstract: boolean;
  description?: string;
  line: number;
  body?: string;
  embedding?: number[];
}

export interface ParsedVariable {
  name: string;
  type: string;
  isPrivate: boolean;
  isProtected: boolean;
  isStatic: boolean;
  isConst: boolean;
  defaultValue?: string;
  line: number;
}

export interface ParsedClass {
  name: string;
  file: string;
  line: number;
  parent?: string;
  isModded: boolean;
  isAbstract: boolean;
  isSealed: boolean;
  methods: ParsedMethod[];
  variables: ParsedVariable[];
  description?: string;
  embedding?: number[];
}

export interface ParsedEnumValue {
  name: string;
  value?: number;
}

export interface ParsedEnum {
  name: string;
  file: string;
  line: number;
  values: ParsedEnumValue[];
  description?: string;
}

export interface ParsedFile {
  path: string;
  layer: ScriptLayer;
  classes: ParsedClass[];
  enums: ParsedEnum[];
  globalFunctions: ParsedMethod[];
  imports: string[];
}

export type ScriptLayer = '1_Core' | '2_GameLib' | '3_Game' | '4_World' | '5_Mission' | 'Unknown';

export interface SearchResult {
  type: 'method' | 'class' | 'enum' | 'variable';
  className?: string;
  methodName?: string;
  enumName?: string;
  variableName?: string;
  signature?: string;
  file: string;
  line: number;
  description?: string;
  confidence: number;
}

export interface FunctionDetails {
  className: string;
  methodName: string;
  signature: string;
  returnType: string;
  parameters: ParsedParameter[];
  description?: string;
  file: string;
  line: number;
  relatedFunctions: string[];
  usageExample?: string;
}

export interface ValidationError {
  line: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
  fix?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  suggestions: string[];
  vanillaAlternatives: { customCode: string; vanillaFunction: string; }[];
}

export interface ClassHierarchy {
  name: string;
  parent?: string;
  children: string[];
  moddedBy: string[];
}

export interface UsageExample {
  file: string;
  line: number;
  code: string;
  context: string;
}

export interface CallSite {
  callerClass: string;
  callerMethod: string;
  callerFile: string;
  callerLine: number;
  calleeClass: string;
  calleeMethod: string;
}

export interface Pattern {
  name: string;
  description: string;
  codeExample: string;
  files: string[];
}

// Интерфейсы для индекса
export interface ScriptIndex {
  classes: Map<string, ParsedClass>;
  enums: Map<string, ParsedEnum>;
  globalFunctions: ParsedMethod[];
  files: ParsedFile[];
}

export interface EmbeddingEntry {
  id: string;
  type: 'class' | 'method' | 'enum';
  className?: string;
  methodName?: string;
  enumName?: string;
  text: string;
  embedding: number[];
  similarity?: number;
}
