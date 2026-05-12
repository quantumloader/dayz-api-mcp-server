// Основной MCP сервер для DayZ Enforce Script

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { FileSystemIndex } from '../indexer/FileSystemIndex.js';
import { CodeValidator } from '../validator/CodeValidator.js';
import { EnforceScriptParser } from '../parser/EnforceScriptParser.js';
import { z } from 'zod';

// Schemas for tool arguments
const SearchFunctionSchema = z.object({
  query: z.string().describe('Search query describing what function you need'),
  searchType: z.enum(['semantic', 'exact', 'fuzzy']).default('semantic'),
  limit: z.number().min(1).max(20).default(5)
});

const GetFunctionDetailsSchema = z.object({
  className: z.string().describe('Class name containing the method'),
  methodName: z.string().describe('Method name to get details for')
});

const ValidateCodeSchema = z.object({
  code: z.string().describe('Enforce Script code to validate')
});

const FindUsageExamplesSchema = z.object({
  className: z.string().describe('Class name'),
  methodName: z.string().describe('Method name'),
  limit: z.number().min(1).max(10).default(3)
});

const GetClassHierarchySchema = z.object({
  className: z.string().describe('Class name to get hierarchy for')
});

const FindVanillaAlternativeSchema = z.object({
  customCode: z.string().describe('Custom code that might have vanilla alternative')
});

const FindCallersSchema = z.object({
  className: z.string().describe('Class name containing the method'),
  methodName: z.string().describe('Method name to find callers for')
});

export class DayZMCP {
  private server: Server;
  private index: FileSystemIndex;
  private validator: CodeValidator;

  constructor() {
    this.server = new Server(
      {
        name: 'dayz-enforce',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        }
      }
    );

    this.index = new FileSystemIndex('./data');
    this.validator = new CodeValidator();

    this.setupToolHandlers();
    this.setupResourceHandlers();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_function',
          description: 'Search for functions in DayZ vanilla scripts by semantic description',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Natural language description of what you need, e.g., "copy weapon attachments"'
              },
              searchType: {
                type: 'string',
                enum: ['semantic', 'exact', 'fuzzy'],
                description: 'Search type: semantic (default) for meaning, exact for pattern matching'
              },
              limit: {
                type: 'number',
                description: 'Maximum results (1-20, default 5)'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'get_function_details',
          description: 'Get detailed information about a specific function including signature, parameters, and usage',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Class name, e.g., "EntityAI"'
              },
              methodName: {
                type: 'string',
                description: 'Method name, e.g., "CopyOldPropertiesToNew"'
              }
            },
            required: ['className', 'methodName']
          }
        },
        {
          name: 'validate_code',
          description: 'Validate Enforce Script code against Iron Rules and check for common mistakes',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Enforce Script code to validate'
              }
            },
            required: ['code']
          }
        },
        {
          name: 'find_usage_examples',
          description: 'Find real usage examples of a function from vanilla DayZ scripts',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Class name'
              },
              methodName: {
                type: 'string',
                description: 'Method name'
              },
              limit: {
                type: 'number',
                description: 'Number of examples (default 3)'
              }
            },
            required: ['className', 'methodName']
          }
        },
        {
          name: 'get_class_hierarchy',
          description: 'Get class inheritance hierarchy and modded extensions',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Class name'
              }
            },
            required: ['className']
          }
        },
        {
          name: 'find_vanilla_alternative',
          description: 'Check if custom code has vanilla DayZ function alternative',
          inputSchema: {
            type: 'object',
            properties: {
              customCode: {
                type: 'string',
                description: 'Your custom implementation'
              }
            },
            required: ['customCode']
          }
        },
        {
          name: 'parse_script',
          description: 'Parse Enforce Script code and extract classes, methods, enums',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Enforce Script code to parse'
              }
            },
            required: ['code']
          }
        },
        {
          name: 'find_callers',
          description: 'Find who calls a specific method in vanilla DayZ scripts (reverse call graph)',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Class name, e.g., "DayZPlayerImplement"'
              },
              methodName: {
                type: 'string',
                description: 'Method name, e.g., "EEKilled"'
              }
            },
            required: ['className', 'methodName']
          }
        }
      ]
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'search_function': {
            const args = SearchFunctionSchema.parse(request.params.arguments);
            
            let results;
            if (args.searchType === 'semantic') {
              results = await this.index.semanticSearch(args.query, args.limit);
            } else {
              results = await this.index.exactSearch(args.query);
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    query: args.query,
                    results: results.map(r => ({
                      type: r.type,
                      name: r.methodName || r.className || r.enumName,
                      class: r.className,
                      text: r.text.substring(0, 300),
                      similarity: r.similarity
                    }))
                  }, null, 2)
                }
              ]
            };
          }

          case 'get_function_details': {
            const args = GetFunctionDetailsSchema.parse(request.params.arguments);

            let entry = await this.index.getById(`method:${args.className}.${args.methodName}`);

            // Fallback: search via class index if not found by exact id
            if (!entry) {
              const cls = this.index.findClass(args.className);
              if (cls) {
                const method = cls.methods.find(m => m.name === args.methodName);
                if (method) {
                  entry = {
                    id: `method:${args.className}.${args.methodName}`,
                    type: 'method',
                    className: args.className,
                    methodName: args.methodName,
                    text: `Method ${args.className}.${args.methodName} returns ${method.returnType} params: ${method.parameters.map(p => `${p.type} ${p.name}`).join(', ')} ${method.signature}`,
                    embedding: []
                  };
                }
              }
            }

            if (!entry) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: `Function ${args.className}.${args.methodName} not found`,
                      suggestion: 'Try searching with search_function tool'
                    }, null, 2)
                  }
                ]
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    className: entry.className,
                    methodName: entry.methodName,
                    description: entry.text,
                    fullDetails: entry
                  }, null, 2)
                }
              ]
            };
          }

          case 'validate_code': {
            const args = ValidateCodeSchema.parse(request.params.arguments);
            
            const result = this.validator.validate(args.code);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    valid: result.valid,
                    errors: result.errors,
                    suggestions: result.suggestions,
                    vanillaAlternatives: result.vanillaAlternatives
                  }, null, 2)
                }
              ]
            };
          }

          case 'find_usage_examples': {
            const args = FindUsageExamplesSchema.parse(request.params.arguments);

            const examples = this.index.findUsageExamples(args.className, args.methodName, args.limit);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    className: args.className,
                    methodName: args.methodName,
                    count: examples.length,
                    examples: examples.map(e => ({
                      id: e.id,
                      type: e.type,
                      className: e.className,
                      methodName: e.methodName,
                      snippet: e.text.substring(0, 260),
                      similarity: e.similarity
                    }))
                  }, null, 2)
                }
              ]
            };
          }

          case 'get_class_hierarchy': {
            const args = GetClassHierarchySchema.parse(request.params.arguments);

            const hierarchy = this.index.getClassHierarchy(args.className);
            if (!hierarchy) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: `Class ${args.className} not found`,
                      suggestion: 'Try search_function with class name'
                    }, null, 2)
                  }
                ]
              };
            }

            const related = this.index.findRelatedClasses(args.className);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    className: hierarchy.className,
                    parent: hierarchy.parent,
                    ancestors: hierarchy.ancestors,
                    children: hierarchy.children,
                    related
                  }, null, 2)
                }
              ]
            };
          }

          case 'find_vanilla_alternative': {
            const args = FindVanillaAlternativeSchema.parse(request.params.arguments);
            
            const result = this.validator.validate(args.customCode);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    customCode: args.customCode,
                    alternatives: result.vanillaAlternatives,
                    suggestion: result.vanillaAlternatives.length > 0
                      ? 'Consider using vanilla functions instead of custom implementation'
                      : 'No vanilla alternatives found - custom implementation may be necessary'
                  }, null, 2)
                }
              ]
            };
          }

          case 'parse_script': {
            const args = ValidateCodeSchema.parse(request.params.arguments);

            const parser = new EnforceScriptParser();
            const parsed = parser.parseString(args.code, '<input>');

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    classes: parsed.classes.map(c => ({
                      name: c.name,
                      parent: c.parent,
                      methods: c.methods.length,
                      variables: c.variables.length
                    })),
                    enums: parsed.enums.map(e => ({
                      name: e.name,
                      values: e.values.length
                    })),
                    globalFunctions: parsed.globalFunctions.length,
                    summary: `Found ${parsed.classes.length} classes, ${parsed.enums.length} enums, ${parsed.globalFunctions.length} global functions`
                  }, null, 2)
                }
              ]
            };
          }

          case 'find_callers': {
            const args = FindCallersSchema.parse(request.params.arguments);
            const callers = this.index.findMethodCallers(args.className, args.methodName);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    callee: `${args.className}.${args.methodName}`,
                    callerCount: callers.length,
                    callers: callers.map(c => ({
                      class: c.callerClass,
                      method: c.callerMethod,
                      file: c.callerFile,
                      line: c.callerLine
                    }))
                  }, null, 2)
                }
              ]
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
          );
        }
        throw error;
      }
    });
  }

  private setupResourceHandlers(): void {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'dayz://classes',
          name: 'DayZ Classes',
          mimeType: 'application/json',
          description: 'List of all indexed DayZ classes'
        },
        {
          uri: 'dayz://patterns/rpc-setup',
          name: 'RPC Setup Pattern',
          mimeType: 'application/json',
          description: 'Standard RPC setup pattern for DayZ mods'
        },
        {
          uri: 'dayz://patterns/singleton',
          name: 'Singleton Pattern',
          mimeType: 'application/json',
          description: 'Proper singleton implementation for DayZ'
        },
        {
          uri: 'dayz://iron-rules',
          name: 'Iron Rules of Enforce Script',
          mimeType: 'application/json',
          description: 'Critical rules that must be followed in Enforce Script'
        },
        {
          uri: 'dayz://vanilla/{filepath}',
          name: 'Vanilla Source File',
          mimeType: 'text/plain',
          description: 'Read content of a vanilla DayZ script file. Use absolute path like P:/scripts/4_world/entities/dayzplayerimplement.c'
        }
      ]
    }));

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;

      switch (uri) {
        case 'dayz://classes': {
          // This would return all classes from the index
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  note: 'Use search_function tool to find specific classes',
                  exampleClasses: ['PlayerBase', 'EntityAI', 'ItemBase', 'MissionServer']
                }, null, 2)
              }
            ]
          };
        }

        case 'dayz://patterns/rpc-setup': {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  description: 'Standard RPC setup pattern',
                  code: `// In 3_Game - Define RPC enum
enum RPC_MYMOD {
  RPC_ACTION = -4710429  // Start from -4710000 + random
}

// In 4_World - Server-side handler
void OnRPC_Server(CallType type, ParamsReadContext ctx, PlayerIdentity sender, Object target) {
  if (type != CallType.Server) return;
  if (!sender) return;
  
  Param1<string> data = new Param1<string>("");
  if (!ctx.Read(data)) return;
  
  // Process and validate
}

// Send RPC
ScriptRPC rpc = new ScriptRPC();
rpc.Write(data);
rpc.Send(player, RPC_MYMOD.RPC_ACTION, true, player.GetIdentity());`,
                  warnings: ['Always validate on server', 'Use unique RPC IDs']
                }, null, 2)
              }
            ]
          };
        }

        case 'dayz://patterns/singleton': {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  description: 'Proper singleton pattern with cleanup',
                  code: `class MyManager {
  private static ref MyManager s_Instance;
  
  static MyManager GetInstance() {
    if (!s_Instance) {
      s_Instance = new MyManager();
    }
    return s_Instance;
  }
  
  static void DestroyInstance() {
    delete s_Instance;
    s_Instance = null;
  }
  
  // In MissionServer/MissionGameplay:
  // MyManager.DestroyInstance(); // Before super.OnMissionFinish()
}`,
                  warnings: ['Always destroy in OnMissionFinish', 'Static ref must be nulled']
                }, null, 2)
              }
            ]
          };
        }

        case 'dayz://iron-rules': {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  rules: [
                    { rule: 'No ternary ? :', fix: 'Use if/else' },
                    { rule: 'No try/catch/finally', fix: 'Use guard clauses' },
                    { rule: 'No do...while', fix: 'Use while with break' },
                    { rule: 'String.ToLower() returns int', fix: 'Modifies in-place' },
                    { rule: 'JsonLoadFile returns void', fix: 'Pass ref object' },
                    { rule: 'No direct cast (PlayerBase)ent', fix: 'Use Class.CastTo()' },
                    { rule: 'GetGame().GetPlayer() null on server', fix: 'Use GetPlayers()' },
                    { rule: 'No backslashes in strings', fix: 'Use forward slashes' },
                    { rule: 'switch/case falls through', fix: 'Always add break' },
                    { rule: 'Vector uses spaces', fix: '"1.0 2.0 3.0" not commas' }
                  ]
                }, null, 2)
              }
            ]
          };
        }

        default:
          if (uri.startsWith('dayz://vanilla/')) {
            const filePath = uri.replace('dayz://vanilla/', '');
            const source = this.index.getVanillaSource(filePath);
            if (source !== null) {
              return {
                contents: [
                  {
                    uri,
                    mimeType: 'text/plain',
                    text: source
                  }
                ]
              };
            }
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Vanilla file not found: ${filePath}`
            );
          }
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Unknown resource: ${uri}`
          );
      }
    });
  }

  async initialize(): Promise<void> {
    await this.index.initialize();
    const stats = this.index.getStats();
    console.error(`DayZ MCP Server initialized:`);
    console.error(`  Classes: ${stats.classes}`);
    console.error(`  Enums: ${stats.enums}`);
    console.error(`  Methods: ${stats.methods}`);
    console.error(`  Embeddings: ${stats.embeddings}`);
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('DayZ MCP Server running on stdio');
  }
}
