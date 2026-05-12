// Валидатор Enforce Script кода
// Проверяет Iron Rules и предлагает исправления

import { ValidationResult, ValidationError } from '../types/index.js';
import { lex } from '../parser/lexer.js';
import { Token } from '../parser/token.js';

export class CodeValidator {
  private static ironRules: Array<{
    name: string;
    check: (code: string, tokens: any[]) => ValidationError | null;
  }> = [
    {
      name: 'ternary_operator',
      check: (code, tokens) => {
        // Проверка на ? :
        const ternaryRegex = /\?\s*[^;]*\s*:/;
        if (ternaryRegex.test(code)) {
          return {
            line: 1,
            message: 'Ternary operator (? :) does not exist in Enforce Script',
            severity: 'error',
            fix: 'Use if/else instead: if (condition) result = a; else result = b;'
          };
        }
        return null;
      }
    },
    {
      name: 'try_catch',
      check: (code, tokens) => {
        if (/\btry\s*\{/.test(code) || /\bcatch\s*\(/.test(code) || /\bfinally\s*\{/.test(code)) {
          return {
            line: 1,
            message: 'try/catch/finally does not exist in Enforce Script',
            severity: 'error',
            fix: 'Use guard clauses and early returns instead of exception handling'
          };
        }
        return null;
      }
    },
    {
      name: 'do_while',
      check: (code, tokens) => {
        if (/\bdo\s*\{/.test(code) && /\}\s*while\s*\(/.test(code)) {
          return {
            line: 1,
            message: 'do...while does not exist in Enforce Script',
            severity: 'error',
            fix: 'Use while with break at the end: while (true) { ... if (!condition) break; }'
          };
        }
        return null;
      }
    },
    {
      name: 'string_to_lower_return',
      check: (code, tokens) => {
        // Проверка на string lower = s.ToLower()
        const regex = /string\s+\w+\s*=\s*[^;]*\.ToLower\(\)/;
        if (regex.test(code)) {
          return {
            line: 1,
            message: 'String.ToLower() returns int (count), not new string',
            severity: 'error',
            fix: 'string s = original; s.ToLower(); // modifies in-place'
          };
        }
        return null;
      }
    },
    {
      name: 'json_load_file_assignment',
      check: (code, tokens) => {
        if (/=\s*JsonFileLoader.*JsonLoadFile/.test(code)) {
          return {
            line: 1,
            message: 'JsonFileLoader.JsonLoadFile() returns void, not data',
            severity: 'error',
            fix: 'MyData data = new MyData(); JsonFileLoader<MyData>.JsonLoadFile(path, data);'
          };
        }
        return null;
      }
    },
    {
      name: 'direct_cast',
      check: (code, tokens) => {
        const regex = /\(\s*(PlayerBase|EntityAI|ItemBase|Man|Object)\s*\)\s*\w+/;
        if (regex.test(code)) {
          return {
            line: 1,
            message: 'Direct C-style cast is unsafe in Enforce Script',
            severity: 'error',
            fix: 'Use Class.CastTo(target, source) instead'
          };
        }
        return null;
      }
    },
    {
      name: 'get_player_on_server',
      check: (code, tokens) => {
        if (/GetGame\(\)\.GetPlayer\(\)/.test(code)) {
          return {
            line: 1,
            message: 'GetGame().GetPlayer() returns null on dedicated server',
            severity: 'warning',
            fix: 'Use GetGame().GetPlayers() for server-side code'
          };
        }
        return null;
      }
    },
    {
      name: 'backslash_in_string',
      check: (code, tokens) => {
        // Проверка на обратные слеши в строках (кроме \n, \t, etc.)
        const stringMatches = code.match(/"[^"]*"/g) || [];
        for (const str of stringMatches) {
          if (/\\[^ntr"\\]/.test(str)) {
            return {
              line: 1,
              message: 'Backslash in strings breaks CParser in Enforce Script',
              severity: 'error',
              fix: 'Use forward slashes for paths: "MyMod/Scripts/file.c"'
            };
          }
        }
        return null;
      }
    },
    {
      name: 'switch_fallthrough',
      check: (code, tokens) => {
        // Проверка на case без break (в Enforce Script switch падает как в C)
        // Это предупреждение, не ошибка
        const switchRegex = /switch\s*\([^)]*\)\s*\{[^}]*case[^}]*\}/s;
        if (switchRegex.test(code)) {
          // Ищем case без break
          const caseRegex = /case\s+\w+\s*:[^}]*?(?=case|default|\})/gs;
          const matches = code.match(caseRegex) || [];
          
          for (const match of matches) {
            if (!match.includes('break') && !match.includes('return')) {
              return {
                line: 1,
                message: 'Case without break - will fall through to next case',
                severity: 'warning',
                fix: 'Add break; at the end of case block if fall-through is not intended'
              };
            }
          }
        }
        return null;
      }
    },
    {
      name: 'vector_literal_format',
      check: (code, tokens) => {
        // Проверка на "1.0, 2.0, 3.0" вместо "1.0 2.0 3.0"
        const vectorRegex = /"[\d.]+,\s*[\d.]+,\s*[\d.]+"/;
        if (vectorRegex.test(code)) {
          return {
            line: 1,
            message: 'Vector literal uses spaces, not commas',
            severity: 'error',
            fix: 'Use "1.0 2.0 3.0" format (spaces between values)'
          };
        }
        return null;
      }
    },
    {
      name: 'forget_synch_dirty',
      check: (code, tokens) => {
        // Проверка на изменение synced переменной без SetSynchDirty
        if (/RegisterNetSyncVariable/.test(code) || /GetHierarchyRootPlayer/.test(code)) {
          // Если есть изменение переменной, но нет SetSynchDirty
          const assignRegex = /\bm_\w+\s*=\s*[^=]/g;
          const hasAssignment = assignRegex.test(code);
          const hasSynchDirty = /SetSynchDirty/.test(code);
          
          if (hasAssignment && !hasSynchDirty) {
            return {
              line: 1,
              message: 'Possible missing SetSynchDirty() after changing synced variable',
              severity: 'warning',
              fix: 'Add SetSynchDirty() after modifying network-synced variables'
            };
          }
        }
        return null;
      }
    },
    {
      name: 'ref_cycle_risk',
      check: (code, tokens) => {
        // Предупреждение о возможных ref циклах
        if (/ref\s+\w+\s+\w+\s*=\s*this/.test(code)) {
          return {
            line: 1,
            message: 'Potential ref cycle - storing reference to self in member variable',
            severity: 'warning',
            fix: 'Ensure one side uses weak reference to prevent memory leak'
          };
        }
        return null;
      }
    },
    {
      name: 'autoptr_usage',
      check: (code, tokens) => {
        if (/\bautoptr\b/.test(code)) {
          return {
            line: 1,
            message: 'autoptr does not exist in Enforce Script',
            severity: 'error',
            fix: 'Use ref keyword instead'
          };
        }
        return null;
      }
    },
    {
      name: 'include_directive',
      check: (code, tokens) => {
        if (/#include/.test(code)) {
          return {
            line: 1,
            message: '#include does not exist in Enforce Script',
            severity: 'error',
            fix: 'All loading is done via config.cpp CfgMods - no includes needed'
          };
        }
        return null;
      }
    },
    {
      name: 'method_overloading',
      check: (code, tokens) => {
        // Enforce Script не поддерживает перегрузку методов
        // Это сложно проверить без полного контекста класса
        // Оставляем как информацию
        return null;
      }
    }
  ];

  validate(code: string): ValidationResult {
    const errors: ValidationError[] = [];
    const suggestions: string[] = [];
    const vanillaAlternatives: { customCode: string; vanillaFunction: string; }[] = [];

    // Tokenize for context
    const tokens = lex(code);

    // Check Iron Rules
    for (const rule of CodeValidator.ironRules) {
      const error = rule.check(code, tokens);
      if (error) {
        errors.push(error);
      }
    }

    // Check for common patterns that could use vanilla functions
    const patterns = this.checkVanillaPatterns(code);
    vanillaAlternatives.push(...patterns);

    // Additional suggestions based on code analysis
    if (/for\s*\(\s*int\s+i\s*=\s*0/.test(code) && /GetInventory\(\)/.test(code)) {
      suggestions.push('Consider using GetInventory().EnumerateInventory() instead of manual iteration');
    }

    if (/vector\.Distance/.test(code)) {
      suggestions.push('vector.Distance() is available for distance calculations');
    }

    if (/GetGame\(\)\.CreateObject/.test(code) && /GetType\(\)/.test(code)) {
      suggestions.push('Consider using EntityAI.CastTo() for safe casting after spawning');
    }

    return {
      valid: errors.length === 0,
      errors,
      suggestions,
      vanillaAlternatives
    };
  }

  private checkVanillaPatterns(code: string): Array<{ customCode: string; vanillaFunction: string; }> {
    const patterns: Array<{ customCode: string; vanillaFunction: string; }> = [];

    // Check for manual attachment copying
    if (/for.*Attachments|attachment.*Insert|GetAttachmentFromIndex/.test(code)) {
      patterns.push({
        customCode: 'Manual attachment iteration and copying',
        vanillaFunction: 'EntityAI.CopyOldPropertiesToNew(EntityAI old_item)'
      });
    }

    // Check for manual player list building
    if (/array<Man>.*players.*GetWorld\(\).*GetPlayerList/.test(code)) {
      patterns.push({
        customCode: 'Manual player list building',
        vanillaFunction: 'GetGame().GetPlayers(array<Man> players)'
      });
    }

    // Check for manual string manipulation
    if (/\.Split\(|\.IndexOf\(|\.Substring\(/.test(code)) {
      patterns.push({
        customCode: 'String parsing/splitting',
        vanillaFunction: 'string.Split(), string.IndexOf(), string.Substring() are built-in'
      });
    }

    // Check for manual inventory slot iteration
    if (/for.*GetInventory\(\).*GetCargo/.test(code)) {
      patterns.push({
        customCode: 'Manual inventory slot iteration',
        vanillaFunction: 'GetInventory().EnumerateInventory() or GetInventory().GetCargo()'
      });
    }

    // Check for manual health/blood operations
    if (/GetHealth\(""|SetHealth\(""|AddHealth/.test(code)) {
      patterns.push({
        customCode: 'Health manipulation',
        vanillaFunction: 'GetHealth(), SetHealth(), AddHealth(), GetStatBlood()'
      });
    }

    return patterns;
  }

  // Check specific API usage
  checkAPIUsage(className: string, methodName: string): string | null {
    const apiChecks: Record<string, Record<string, string>> = {
      'EntityAI': {
        'CopyOldPropertiesToNew': 'Copies all properties and attachments from another entity',
        'GetInventory': 'Returns the entity\'s inventory for manipulation',
        'SetPosition': 'Sets entity position (use instead of manual position assignment)',
        'GetPosition': 'Gets entity position vector'
      },
      'PlayerBase': {
        'GetIdentity': 'Returns PlayerIdentity (null on server for some contexts)',
        'GetInventory': 'Returns player inventory',
        'SetSynchDirty': 'Required after changing network-synced variables'
      },
      'GetGame': {
        'GetPlayer': 'Returns null on dedicated server - use GetPlayers() instead',
        'GetPlayers': 'Returns all players (safe on both client and server)'
      }
    };

    return apiChecks[className]?.[methodName] || null;
  }
}
