// Полная реализация индекса с сохранением в файловую систему

import * as fs from 'fs';
import * as path from 'path';
import { Indexer } from './Indexer.js';
import { ParsedClass, ParsedMethod, ParsedEnum, EmbeddingEntry, CallSite } from '../types/index.js';

interface FieldedDocument {
  id: string;
  name: string;
  fullName: string;
  entityType: 'class' | 'method' | 'enum';
  className?: string;
  description: string;
  signature: string;
  returnType: string;
  file: string;
  content: string;
}

interface ClassHierarchyInfo {
  className: string;
  parent?: string;
  ancestors: string[];
  children: string[];
}

export class FileSystemIndex implements Indexer {
  private dataDir: string;
  private classes: Map<string, ParsedClass>;
  private enums: Map<string, ParsedEnum>;
  private embeddings: EmbeddingEntry[];
  private initialized: boolean = false;
  private termDocFreq: Map<string, number>;
  private docTermFreq: Map<string, Map<string, number>>;
  private docLengths: Map<string, number>;
  private avgDocLength: number;
  private documents: Map<string, FieldedDocument>;
  private inheritanceChildrenMap: Map<string, Set<string>>;
  private usageMap: Map<string, Set<string>>;
  private methodNameIndex: Map<string, EmbeddingEntry[]>;
  private classNameIndex: Map<string, EmbeddingEntry[]>;
  private reverseCallIndex: Map<string, CallSite[]>;

  private static readonly EMBEDDING_DIM = 256;
  private static readonly STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'over',
    'void', 'true', 'false', 'null', 'get', 'set', 'new', 'class', 'method'
  ]);

  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
    this.classes = new Map();
    this.enums = new Map();
    this.embeddings = [];
    this.termDocFreq = new Map();
    this.docTermFreq = new Map();
    this.docLengths = new Map();
    this.avgDocLength = 0;
    this.documents = new Map();
    this.inheritanceChildrenMap = new Map();
    this.usageMap = new Map();
    this.methodNameIndex = new Map();
    this.classNameIndex = new Map();
    this.reverseCallIndex = new Map();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create data directory if not exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Load existing index
    await this.load();
    
    this.initialized = true;
    console.error(`FileSystemIndex initialized: ${this.classes.size} classes, ${this.enums.size} enums, ${this.embeddings.length} embeddings`);
  }

  async indexClass(cls: ParsedClass): Promise<void> {
    if (!this.initialized) await this.initialize();

    // Store class
    this.classes.set(cls.name, cls);

    // Create class embedding
    const classText = this.createClassText(cls);
    this.addEmbedding({
      id: `class:${cls.name}`,
      type: 'class',
      className: cls.name,
      text: classText,
      embedding: this.createEmbedding(classText)
    }, {
      id: `class:${cls.name}`,
      name: cls.name,
      fullName: cls.name,
      entityType: 'class',
      className: cls.name,
      description: '',
      signature: '',
      returnType: '',
      file: cls.file,
      content: classText
    });

    // Index all methods
    for (const method of cls.methods) {
      const methodText = this.createMethodText(cls, method);
      const entry: EmbeddingEntry = {
        id: `method:${cls.name}.${method.name}`,
        type: 'method',
        className: cls.name,
        methodName: method.name,
        text: methodText,
        embedding: this.createEmbedding(methodText)
      };
      this.addEmbedding(entry, {
        id: `method:${cls.name}.${method.name}`,
        name: method.name,
        fullName: `${cls.name}.${method.name}`,
        entityType: 'method',
        className: cls.name,
        description: '',
        signature: method.signature,
        returnType: method.returnType,
        file: cls.file,
        content: methodText
      });

      // Build exact search indexes
      const methodKey = method.name.toLowerCase();
      const existingMethods = this.methodNameIndex.get(methodKey) || [];
      existingMethods.push(entry);
      this.methodNameIndex.set(methodKey, existingMethods);

      const classKey = cls.name.toLowerCase();
      const existingClasses = this.classNameIndex.get(classKey) || [];
      existingClasses.push(entry);
      this.classNameIndex.set(classKey, existingClasses);
    }

    this.updateClassRelationships(cls);
  }

  async indexEnum(enumDef: ParsedEnum): Promise<void> {
    if (!this.initialized) await this.initialize();

    this.enums.set(enumDef.name, enumDef);

    const enumText = this.createEnumText(enumDef);
    this.addEmbedding({
      id: `enum:${enumDef.name}`,
      type: 'enum',
      enumName: enumDef.name,
      text: enumText,
      embedding: this.createEmbedding(enumText)
    }, {
      id: `enum:${enumDef.name}`,
      name: enumDef.name,
      fullName: enumDef.name,
      entityType: 'enum',
      description: '',
      signature: '',
      returnType: '',
      file: enumDef.file,
      content: enumText
    });
  }

  async semanticSearch(query: string, limit: number = 10): Promise<EmbeddingEntry[]> {
    if (!this.initialized) await this.initialize();

    const queryTokens = this.tokenizeForSearch(query);
    const expandedQueryTokens = this.expandQueryTokens(queryTokens);
    const queryUniqueTerms = Array.from(new Set(expandedQueryTokens));
    const queryVector = this.createEmbedding(query);
    const queryLower = query.toLowerCase();
    const hasActionIntent = this.hasActionIntent(queryUniqueTerms);
    const hasRpcIntent = queryUniqueTerms.includes('rpc');
    const hasClientIntent = queryUniqueTerms.includes('client');
    const hasServerIntent = queryUniqueTerms.includes('server');

    const queryTermSet = new Set(queryUniqueTerms);
    const intermediate = this.embeddings.map(entry => {
      const bm25Score = this.computeBm25Score(queryUniqueTerms, entry.id);
      const semanticScore = this.cosineSimilarity(queryVector, entry.embedding);
      const lexicalScore = this.computeLexicalScore(queryTermSet, entry.text);
      const symbolScore = this.computeSymbolScore(queryLower, entry);
      const fieldScore = this.computeFieldScore(queryUniqueTerms, entry.id);
      const typeWeight = this.computeTypeWeight(entry, hasActionIntent);
      const intentBoost = this.computeIntentBoost(entry, hasRpcIntent, hasClientIntent, hasServerIntent);
      const noisePenalty = this.computeNoisePenalty(entry);

      return {
        entry,
        bm25Score,
        semanticScore,
        lexicalScore,
        symbolScore,
        fieldScore,
        typeWeight,
        intentBoost,
        noisePenalty
      };
    });

    const maxBm25 = intermediate.reduce((max, item) => Math.max(max, item.bm25Score), 0);

    const results = intermediate.map(item => {
      const normalizedBm25 = maxBm25 > 0 ? item.bm25Score / maxBm25 : 0;
      const baseScore = normalizedBm25 * 0.4 + item.semanticScore * 0.2 + item.lexicalScore * 0.15 + item.symbolScore * 0.1 + item.fieldScore * 0.15;
      const weightedScore = baseScore * item.typeWeight + item.intentBoost - item.noisePenalty;
      return {
        ...item.entry,
        similarity: Math.max(0, Math.min(1, weightedScore))
      };
    });

    results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    
    return results.slice(0, limit);
  }

  async exactSearch(pattern: string): Promise<EmbeddingEntry[]> {
    if (!this.initialized) await this.initialize();

    const lowerPattern = pattern.toLowerCase();

    // 1. Exact method name match (fast path)
    const methodMatches = this.methodNameIndex.get(lowerPattern);
    if (methodMatches && methodMatches.length > 0) {
      return methodMatches.map(entry => ({ ...entry, similarity: 1 }));
    }

    // 2. Exact class name match
    const classMatches = this.classNameIndex.get(lowerPattern);
    if (classMatches && classMatches.length > 0) {
      return classMatches.map(entry => ({ ...entry, similarity: 1 }));
    }

    // 3. Full qualified method search (Class.Method)
    const dotIndex = lowerPattern.indexOf('.');
    if (dotIndex > 0) {
      const classPart = lowerPattern.substring(0, dotIndex);
      const methodPart = lowerPattern.substring(dotIndex + 1);
      const entries = this.classNameIndex.get(classPart);
      if (entries) {
        const filtered = entries.filter(e =>
          e.methodName && e.methodName.toLowerCase() === methodPart
        );
        if (filtered.length > 0) {
          return filtered.map(entry => ({ ...entry, similarity: 1 }));
        }
      }
    }

    // 4. Fallback to regex search over embeddings text
    const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return this.embeddings
      .filter(entry => regex.test(entry.text))
      .map(entry => ({ ...entry, similarity: 1 }));
  }

  async getById(id: string): Promise<EmbeddingEntry | null> {
    if (!this.initialized) await this.initialize();
    return this.embeddings.find(e => e.id === id) || null;
  }

  async clear(): Promise<void> {
    this.classes.clear();
    this.enums.clear();
    this.embeddings = [];
    this.termDocFreq.clear();
    this.docTermFreq.clear();
    this.docLengths.clear();
    this.avgDocLength = 0;
    this.documents.clear();
    this.inheritanceChildrenMap.clear();
    this.usageMap.clear();
    this.methodNameIndex.clear();
    this.classNameIndex.clear();
    this.reverseCallIndex.clear();

    const indexFile = path.join(this.dataDir, 'index.json');
    if (fs.existsSync(indexFile)) {
      fs.unlinkSync(indexFile);
    }
  }

  async count(): Promise<number> {
    if (!this.initialized) await this.initialize();
    return this.embeddings.length;
  }

  async save(): Promise<void> {
    const data = {
      version: 2,
      timestamp: new Date().toISOString(),
      classes: Array.from(this.classes.entries()),
      enums: Array.from(this.enums.entries()),
      embeddings: this.embeddings,
      documents: Array.from(this.documents.entries()),
      methodNameIndex: Array.from(this.methodNameIndex.entries()),
      classNameIndex: Array.from(this.classNameIndex.entries()),
      reverseCallIndex: Array.from(this.reverseCallIndex.entries())
    };

    const indexFile = path.join(this.dataDir, 'index.json');
    fs.writeFileSync(indexFile, JSON.stringify(data, null, 2));

    console.error(`Index saved: ${this.classes.size} classes, ${this.enums.size} enums, ${this.embeddings.length} embeddings`);
  }

  findClass(name: string): ParsedClass | undefined {
    return this.classes.get(name);
  }

  findEnum(name: string): ParsedEnum | undefined {
    return this.enums.get(name);
  }

  findMethod(className: string, methodName: string): ParsedMethod | undefined {
    const cls = this.classes.get(className);
    return cls?.methods.find(m => m.name === methodName);
  }

  getAllClasses(): ParsedClass[] {
    return Array.from(this.classes.values());
  }

  getClassMethods(className: string): ParsedMethod[] {
    return this.findClass(className)?.methods || [];
  }

  getClassHierarchy(className: string): ClassHierarchyInfo | null {
    const cls = this.classes.get(className);
    if (!cls) return null;

    const ancestors: string[] = [];
    const visited = new Set<string>();
    let cursor = cls.parent;

    while (cursor && !visited.has(cursor)) {
      ancestors.push(cursor);
      visited.add(cursor);
      cursor = this.classes.get(cursor)?.parent;
    }

    const children = Array.from(this.inheritanceChildrenMap.get(className) || []);

    return {
      className,
      parent: cls.parent,
      ancestors,
      children
    };
  }

  findUsageExamples(className: string, methodName: string, limit: number = 3): EmbeddingEntry[] {
    const methodNameLower = methodName.toLowerCase();
    const fqMethod = `${className.toLowerCase()}.${methodNameLower}`;
    const results: EmbeddingEntry[] = [];

    for (const entry of this.embeddings) {
      if (entry.type !== 'method') continue;

      const methodText = entry.text.toLowerCase();
      const entryClass = (entry.className || '').toLowerCase();
      const entryMethod = (entry.methodName || '').toLowerCase();
      const entryFq = `${entryClass}.${entryMethod}`;

      if (entryFq === fqMethod || methodText.includes(fqMethod) || entryMethod === methodNameLower) {
        results.push({
          ...entry,
          similarity: entryFq === fqMethod ? 1 : 0.75
        });
      }
    }

    return results.slice(0, limit);
  }

  findRelatedClasses(className: string): { name: string; relation: 'parent' | 'child' | 'uses' | 'used_by' }[] {
    const related: { name: string; relation: 'parent' | 'child' | 'uses' | 'used_by' }[] = [];
    const cls = this.classes.get(className);
    if (!cls) return related;

    if (cls.parent) {
      related.push({ name: cls.parent, relation: 'parent' });
    }

    for (const child of this.inheritanceChildrenMap.get(className) || []) {
      related.push({ name: child, relation: 'child' });
    }

    for (const used of this.usageMap.get(className) || []) {
      related.push({ name: used, relation: 'uses' });
    }

    for (const [fromClass, usedSet] of this.usageMap.entries()) {
      if (usedSet.has(className) && fromClass !== className) {
        related.push({ name: fromClass, relation: 'used_by' });
      }
    }

    const seen = new Set<string>();
    return related.filter(item => {
      const key = `${item.relation}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Statistics
  getStats(): { classes: number; enums: number; methods: number; embeddings: number } {
    const methodCount = Array.from(this.classes.values())
      .reduce((sum, cls) => sum + cls.methods.length, 0);
    
    return {
      classes: this.classes.size,
      enums: this.enums.size,
      methods: methodCount,
      embeddings: this.embeddings.length
    };
  }

  private async load(): Promise<void> {
    const indexFile = path.join(this.dataDir, 'index.json');
    if (!fs.existsSync(indexFile)) {
      console.error('No existing index found');
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));

      this.classes = new Map(data.classes || []);
      this.enums = new Map(data.enums || []);
      this.embeddings = data.embeddings || [];
      this.documents = new Map(data.documents || []);
      this.methodNameIndex = new Map(data.methodNameIndex || []);
      this.classNameIndex = new Map(data.classNameIndex || []);
      this.reverseCallIndex = new Map(data.reverseCallIndex || []);
      if (this.documents.size === 0) {
        this.rebuildDocumentsFromEmbeddings();
      }
      if (this.methodNameIndex.size === 0) {
        this.rebuildNameIndexes();
      }
      this.rebuildSearchStructures();
      this.rebuildRelationshipStructures();

      console.error(`Loaded index: ${this.classes.size} classes, ${this.enums.size} enums, ${this.embeddings.length} embeddings`);
    } catch (error) {
      console.error('Failed to load index:', error);
    }
  }

  private addEmbedding(entry: EmbeddingEntry, doc?: FieldedDocument): void {
    const indexedEntry: EmbeddingEntry = {
      ...entry,
      embedding: this.createEmbedding(entry.text)
    };

    if (doc) {
      this.documents.set(doc.id, doc);
    }

    // Check if entry with this ID already exists
    const existingIndex = this.embeddings.findIndex(e => e.id === entry.id);
    if (existingIndex >= 0) {
      this.removeDocStats(this.embeddings[existingIndex].id);
      this.embeddings[existingIndex] = indexedEntry;
    } else {
      this.embeddings.push(indexedEntry);
    }

    this.addDocStats(indexedEntry);
  }

  private createClassText(cls: ParsedClass): string {
    const parts = [
      `Class ${cls.name}`,
      cls.parent ? `extends ${cls.parent}` : '',
      cls.isModded ? '[modded]' : '',
      cls.isAbstract ? '[abstract]' : '',
      cls.isSealed ? '[sealed]' : '',
      `Methods: ${cls.methods.map(m => m.name).join(', ')}`,
      `Variables: ${cls.variables.map(v => v.name).join(', ')}`,
      cls.file
    ];
    return parts.filter(p => p).join(' ');
  }

  private createMethodText(cls: ParsedClass, method: ParsedMethod): string {
    const parts = [
      `Method ${cls.name}.${method.name}`,
      method.isOverride ? '[override]' : '',
      method.isStatic ? '[static]' : '',
      method.isPrivate ? '[private]' : '',
      method.isProtected ? '[protected]' : '',
      `returns ${method.returnType}`,
      `params: ${method.parameters.map(p => `${p.type} ${p.name}`).join(', ')}`,
      method.signature,
      cls.file
    ];
    return parts.filter(p => p).join(' ');
  }

  private createEnumText(enumDef: ParsedEnum): string {
    return `Enum ${enumDef.name} values: ${enumDef.values.map(v => v.name).join(', ')} ${enumDef.file}`;
  }

  private createEmbedding(text: string): number[] {
    const tokens = this.tokenizeForSearch(text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    const vector = new Array<number>(FileSystemIndex.EMBEDDING_DIM).fill(0);
    for (const [token, count] of tf) {
      const idx = this.hashToken(token) % FileSystemIndex.EMBEDDING_DIM;
      vector[idx] += 1 + Math.log(1 + count);
    }

    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (magnitude === 0) return vector;
    return vector.map(value => value / magnitude);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      magnitudeA += a[i] * a[i];
      magnitudeB += b[i] * b[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
  }

  private tokenizeForSearch(text: string): string[] {
    const normalized = text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^a-zA-Z0-9_./:]+/g, ' ')
      .replace(/[./:]/g, ' ')
      .toLowerCase();

    const tokens = normalized
      .split(/\s+/)
      .flatMap(token => token.split('_'))
      .filter(token => token.length >= 2 && !FileSystemIndex.STOP_WORDS.has(token));

    return tokens;
  }

  private computeLexicalScore(queryTokens: Set<string>, text: string): number {
    if (queryTokens.size === 0) return 0;

    const textTokens = new Set(this.tokenizeForSearch(text));
    let matched = 0;

    for (const token of queryTokens) {
      if (textTokens.has(token)) {
        matched++;
      }
    }

    return matched / queryTokens.size;
  }

  private computeBm25Score(queryTerms: string[], docId: string): number {
    if (queryTerms.length === 0 || this.embeddings.length === 0) return 0;

    const tfMap = this.docTermFreq.get(docId);
    if (!tfMap) return 0;

    const docLength = this.docLengths.get(docId) || 0;
    const avgLength = this.avgDocLength || 1;
    const k1 = 1.5;
    const b = 0.75;
    const nDocs = this.embeddings.length;

    let score = 0;
    for (const term of queryTerms) {
      const tf = tfMap.get(term) || 0;
      if (tf === 0) continue;

      const df = this.termDocFreq.get(term) || 0;
      const idf = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLength / avgLength));

      score += idf * (numerator / denominator);
    }

    return score;
  }

  private computeSymbolScore(queryLower: string, entry: EmbeddingEntry): number {
    let score = 0;
    const className = (entry.className || '').toLowerCase();
    const methodName = (entry.methodName || '').toLowerCase();
    const enumName = (entry.enumName || '').toLowerCase();
    const fullMethod = methodName ? `${className}.${methodName}` : '';

    if (className && queryLower.includes(className)) score += 0.6;
    if (methodName && queryLower.includes(methodName)) score += 0.8;
    if (fullMethod && queryLower.includes(fullMethod)) score += 1.0;
    if (enumName && queryLower.includes(enumName)) score += 0.8;

    if (queryLower.includes('rpc') && entry.text.toLowerCase().includes('rpc')) score += 0.3;
    if (queryLower.includes('client') && entry.text.toLowerCase().includes('client')) score += 0.2;
    if (queryLower.includes('server') && entry.text.toLowerCase().includes('server')) score += 0.2;

    return Math.min(1, score);
  }

  private computeFieldScore(queryTerms: string[], docId: string): number {
    if (queryTerms.length === 0) return 0;
    const doc = this.documents.get(docId);
    if (!doc) return 0;

    const fieldWeights: Array<[string, number]> = [
      [doc.name.toLowerCase(), 1.0],
      [doc.fullName.toLowerCase(), 1.0],
      [doc.className?.toLowerCase() || '', 0.8],
      [doc.signature.toLowerCase(), 0.7],
      [doc.returnType.toLowerCase(), 0.4],
      [doc.content.toLowerCase(), 0.5]
    ];

    let score = 0;
    for (const term of queryTerms) {
      for (const [fieldValue, weight] of fieldWeights) {
        if (!fieldValue) continue;
        if (fieldValue === term) {
          score += weight;
          continue;
        }
        if (fieldValue.includes(term)) {
          score += weight * 0.5;
        }
      }
    }

    const norm = queryTerms.length * 2.5;
    return Math.min(1, score / norm);
  }

  private expandQueryTokens(tokens: string[]): string[] {
    const synonymMap: Record<string, string[]> = {
      rpc: ['scriptrpc', 'onrpc', 'rpcsingleparam', 'rpcsend', 'rpcs'],
      send: ['dispatch', 'transmit', 'sync', 'senddata', 'rpcsend'],
      client: ['clientside', 'local', 'gameplay'],
      server: ['serverside', 'authoritative', 'missionserver'],
      inventory: ['attachment', 'cargo', 'entityai'],
      spawn: ['createobject', 'createininventory', 'spawned']
    };

    const expanded = [...tokens];
    for (const token of tokens) {
      const synonyms = synonymMap[token];
      if (synonyms) {
        expanded.push(...synonyms);
      }
    }

    return expanded;
  }

  private hasActionIntent(tokens: string[]): boolean {
    const actionWords = new Set([
      'send', 'set', 'get', 'create', 'spawn', 'copy', 'transfer', 'validate',
      'sync', 'load', 'save', 'register', 'dispatch', 'handle', 'process'
    ]);
    return tokens.some(token => actionWords.has(token));
  }

  private computeTypeWeight(entry: EmbeddingEntry, hasActionIntent: boolean): number {
    if (hasActionIntent) {
      if (entry.type === 'method') return 1.2;
      if (entry.type === 'class') return 0.92;
      return 0.82;
    }

    if (entry.type === 'method') return 1.05;
    if (entry.type === 'class') return 1.0;
    return 0.95;
  }

  private computeIntentBoost(
    entry: EmbeddingEntry,
    hasRpcIntent: boolean,
    hasClientIntent: boolean,
    hasServerIntent: boolean
  ): number {
    let boost = 0;
    const text = entry.text.toLowerCase();
    const methodName = (entry.methodName || '').toLowerCase();

    if (hasRpcIntent) {
      if (text.includes('rpc')) boost += 0.12;
      if (methodName.includes('onrpc')) boost += 0.15;
      if (methodName.includes('send')) boost += 0.08;
    }

    if (hasClientIntent && text.includes('client')) boost += 0.07;
    if (hasServerIntent && text.includes('server')) boost += 0.07;

    return Math.min(0.25, boost);
  }

  private computeNoisePenalty(entry: EmbeddingEntry): number {
    const className = (entry.className || '').toLowerCase();
    const methodName = (entry.methodName || '').toLowerCase();
    const text = entry.text.toLowerCase();

    let penalty = 0;

    if (entry.type === 'method' && className && methodName && className === methodName) {
      penalty += 0.12;
    }

    if (entry.type === 'class') {
      const methodListMatch = text.match(/methods:\s*([^\[]+)/);
      if (methodListMatch) {
        const listedMethods = methodListMatch[1]
          .split(',')
          .map(m => m.trim())
          .filter(Boolean);
        if (listedMethods.length <= 1) {
          penalty += 0.06;
        }
      }
    }

    return Math.min(0.18, penalty);
  }

  private addDocStats(entry: EmbeddingEntry): void {
    const tokens = this.tokenizeForSearch(entry.text);
    const tfMap = new Map<string, number>();

    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + 1);
    }

    this.docTermFreq.set(entry.id, tfMap);
    this.docLengths.set(entry.id, tokens.length);

    for (const term of tfMap.keys()) {
      this.termDocFreq.set(term, (this.termDocFreq.get(term) || 0) + 1);
    }

    this.recalculateAvgDocLength();
  }

  private updateClassRelationships(cls: ParsedClass): void {
    if (cls.parent) {
      const children = this.inheritanceChildrenMap.get(cls.parent) || new Set<string>();
      children.add(cls.name);
      this.inheritanceChildrenMap.set(cls.parent, children);
    }

    const usedTypes = this.extractReferencedTypesFromClass(cls);
    this.usageMap.set(cls.name, usedTypes);
  }

  private extractReferencedTypesFromClass(cls: ParsedClass): Set<string> {
    const used = new Set<string>();

    const addTypeRef = (rawType?: string) => {
      if (!rawType) return;
      const candidates = this.normalizeTypeReferences(rawType);
      for (const candidate of candidates) {
        if (candidate && candidate !== cls.name) {
          used.add(candidate);
        }
      }
    };

    for (const variable of cls.variables) {
      addTypeRef(variable.type);
    }

    for (const method of cls.methods) {
      addTypeRef(method.returnType);
      for (const param of method.parameters) {
        addTypeRef(param.type);
      }
    }

    return used;
  }

  private normalizeTypeReferences(rawType: string): string[] {
    const cleaned = rawType
      .replace(/\b(ref|out|autoptr|const|typename)\b/g, ' ')
      .replace(/[<>,\[\]\(\)\*:&]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return [];

    const primitive = new Set(['void', 'int', 'float', 'bool', 'string', 'vector', 'array', 'map', 'set', 'auto']);
    return cleaned
      .split(' ')
      .map(part => part.trim())
      .filter(part => part.length > 1 && !primitive.has(part.toLowerCase()));
  }

  private removeDocStats(docId: string): void {
    const tfMap = this.docTermFreq.get(docId);
    if (!tfMap) return;

    for (const term of tfMap.keys()) {
      const current = this.termDocFreq.get(term) || 0;
      if (current <= 1) {
        this.termDocFreq.delete(term);
      } else {
        this.termDocFreq.set(term, current - 1);
      }
    }

    this.docTermFreq.delete(docId);
    this.docLengths.delete(docId);
    this.recalculateAvgDocLength();
  }

  private rebuildSearchStructures(): void {
    this.termDocFreq.clear();
    this.docTermFreq.clear();
    this.docLengths.clear();
    this.avgDocLength = 0;

    for (const entry of this.embeddings) {
      if (!entry.embedding || entry.embedding.length === 0) {
        entry.embedding = this.createEmbedding(entry.text);
      }
      this.addDocStats(entry);
    }
  }

  private rebuildRelationshipStructures(): void {
    this.inheritanceChildrenMap.clear();
    this.usageMap.clear();

    for (const cls of this.classes.values()) {
      this.updateClassRelationships(cls);
    }
  }

  private rebuildDocumentsFromEmbeddings(): void {
    this.documents.clear();
    for (const entry of this.embeddings) {
      const fullName = entry.type === 'method'
        ? `${entry.className || ''}.${entry.methodName || ''}`
        : (entry.className || entry.enumName || entry.id);
      const name = entry.methodName || entry.className || entry.enumName || entry.id;

      this.documents.set(entry.id, {
        id: entry.id,
        name,
        fullName,
        entityType: entry.type,
        className: entry.className,
        description: '',
        signature: '',
        returnType: '',
        file: '',
        content: entry.text
      });
    }
  }

  private recalculateAvgDocLength(): void {
    if (this.docLengths.size === 0) {
      this.avgDocLength = 0;
      return;
    }

    let total = 0;
    for (const value of this.docLengths.values()) {
      total += value;
    }
    this.avgDocLength = total / this.docLengths.size;
  }

  // Reverse call index: who calls this method
  buildReverseCallIndex(): void {
    this.reverseCallIndex.clear();
    const callRegex = /(\w+)(?:\.(\w+))?\s*\(/g;

    for (const cls of this.classes.values()) {
      for (const method of cls.methods) {
        if (!method.body) continue;
        let match;
        while ((match = callRegex.exec(method.body)) !== null) {
          const calleeMethod = match[2] || match[1];
          const calleeClass = match[2] ? match[1] : cls.name;
          const key = `${calleeClass.toLowerCase()}.${calleeMethod.toLowerCase()}`;

          const sites = this.reverseCallIndex.get(key) || [];
          sites.push({
            callerClass: cls.name,
            callerMethod: method.name,
            callerFile: cls.file,
            callerLine: method.line,
            calleeClass,
            calleeMethod
          });
          this.reverseCallIndex.set(key, sites);
        }
      }
    }
  }

  findMethodCallers(className: string, methodName: string): CallSite[] {
    const key = `${className.toLowerCase()}.${methodName.toLowerCase()}`;
    return this.reverseCallIndex.get(key) || [];
  }

  // Vanilla file content lookup
  getVanillaSource(filePath: string): string | null {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  }

  private rebuildNameIndexes(): void {
    this.methodNameIndex.clear();
    this.classNameIndex.clear();

    for (const entry of this.embeddings) {
      if (entry.type === 'method') {
        if (entry.methodName) {
          const key = entry.methodName.toLowerCase();
          const arr = this.methodNameIndex.get(key) || [];
          arr.push(entry);
          this.methodNameIndex.set(key, arr);
        }
        if (entry.className) {
          const key = entry.className.toLowerCase();
          const arr = this.classNameIndex.get(key) || [];
          arr.push(entry);
          this.classNameIndex.set(key, arr);
        }
      }
    }
  }

  private hashToken(token: string): number {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }
}
