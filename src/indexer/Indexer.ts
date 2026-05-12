// Интерфейс для всех индексаторов

import { ParsedClass, ParsedMethod, ParsedEnum, EmbeddingEntry } from '../types/index.js';

export interface Indexer {
  initialize(): Promise<void>;
  indexClass(cls: ParsedClass): Promise<void>;
  indexEnum(enumDef: ParsedEnum): Promise<void>;
  semanticSearch(query: string, limit?: number): Promise<EmbeddingEntry[]>;
  exactSearch(pattern: string): Promise<EmbeddingEntry[]>;
  getById(id: string): Promise<EmbeddingEntry | null>;
  clear(): Promise<void>;
  count(): Promise<number>;
  save(): Promise<void>;
  findClass(name: string): ParsedClass | undefined;
  findEnum(name: string): ParsedEnum | undefined;
  findMethod(className: string, methodName: string): ParsedMethod | undefined;
  getAllClasses(): ParsedClass[];
  getClassMethods(className: string): ParsedMethod[];
  getClassHierarchy(className: string): {
    className: string;
    parent?: string;
    ancestors: string[];
    children: string[];
  } | null;
  findUsageExamples(className: string, methodName: string, limit?: number): EmbeddingEntry[];
  findRelatedClasses(className: string): {
    name: string;
    relation: 'parent' | 'child' | 'uses' | 'used_by';
  }[];
  findMethodCallers(className: string, methodName: string): import('../types/index.js').CallSite[];
  getVanillaSource(filePath: string): string | null;
}
