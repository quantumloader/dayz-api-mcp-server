#!/usr/bin/env node
// CLI tool for indexing DayZ scripts

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { EnforceScriptParser } from '../parser/EnforceScriptParser.js';
import { FileSystemIndex } from './FileSystemIndex.js';

const program = new Command();

program
  .name('dayz-indexer')
  .description('Index DayZ Enforce Script files for MCP server')
  .version('1.0.0');

program
  .command('index')
  .description('Index all .c files in the specified directory')
  .argument('<path>', 'Path to DayZ scripts directory (e.g., P:/scripts)')
  .option('-o, --openai', 'Use OpenAI embeddings (requires OPENAI_API_KEY)')
  .option('-c, --clear', 'Clear existing index before indexing')
  .option('-l, --layer <layer>', 'Index only specific layer (1_Core, 2_GameLib, 3_Game, 4_World, 5_Mission)')
  .action(async (scriptsPath, options) => {
    console.log(chalk.blue.bold('DayZ Enforce Script Indexer\n'));

    // Validate path
    if (!fs.existsSync(scriptsPath)) {
      console.error(chalk.red(`Error: Path does not exist: ${scriptsPath}`));
      process.exit(1);
    }

    const spinner = ora('Initializing index...').start();
    
    try {
      const indexer = new FileSystemIndex('./data');
      
      await indexer.initialize();
      spinner.succeed(`Index initialized: ${indexer.getStats().classes} classes, ${indexer.getStats().embeddings} embeddings`);

      if (options.clear) {
        const clearSpinner = ora('Clearing existing index...').start();
        await indexer.clear();
        clearSpinner.succeed('Index cleared');
      }

      // Find files
      const findSpinner = ora('Finding script files...').start();
      
      let pattern = path.join(scriptsPath, '**/*.c').replace(/\\/g, '/');
      if (options.layer) {
        pattern = path.join(scriptsPath, `**/${options.layer}/**/*.c`).replace(/\\/g, '/');
      }
      
      const files = await glob(pattern);
      findSpinner.succeed(`Found ${files.length} script files`);

      if (files.length === 0) {
        console.log(chalk.yellow('No files to index. Exiting.'));
        return;
      }

      // Parse and index
      const indexSpinner = ora('Indexing files...').start();
      let indexed = 0;
      let errors = 0;

      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const relativePath = path.relative(scriptsPath, filePath);
        
        if (i % 50 === 0) {
          indexSpinner.text = `Indexing files... (${i + 1}/${files.length}) ${relativePath}`;
        }

        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const parser = new EnforceScriptParser();
          const parsed = parser.parseString(content, filePath);

          // Index classes
          for (const cls of parsed.classes) {
            await indexer.indexClass(cls);
          }

          // Index enums
          for (const enumDef of parsed.enums) {
            await indexer.indexEnum(enumDef);
          }

          indexed++;
        } catch (error) {
          errors++;
          console.error(chalk.red(`\nError parsing ${relativePath}:`), error);
        }
      }

      indexSpinner.succeed(`Indexed ${indexed} files (${errors} errors)`);

      // Build reverse call index
      const callSpinner = ora('Building reverse call index...').start();
      indexer.buildReverseCallIndex();
      callSpinner.succeed('Reverse call index built');

      // Save index to disk
      const saveSpinner = ora('Saving index to disk...').start();
      await indexer.save();
      saveSpinner.succeed('Index saved');

      const stats = indexer.getStats();
      console.log(chalk.green(`\nIndex complete!`));
      console.log(chalk.cyan(`  Classes: ${stats.classes}`));
      console.log(chalk.cyan(`  Enums: ${stats.enums}`));
      console.log(chalk.cyan(`  Methods: ${stats.methods}`));
      console.log(chalk.cyan(`  Total embeddings: ${stats.embeddings}`));

    } catch (error) {
      spinner.fail('Failed to initialize');
      console.error(chalk.red(error));
      process.exit(1);
    }
  });

program
  .command('search')
  .description('Search indexed functions')
  .argument('<query>', 'Search query')
  .option('-l, --limit <number>', 'Number of results', '5')
  .option('-t, --type <type>', 'Search type: semantic or exact', 'semantic')
  .option('-e, --entity-type <entityType>', 'Entity type filter: method, class, enum')
  .action(async (query, options) => {
    console.log(chalk.blue.bold('Searching DayZ Scripts\n'));

    const spinner = ora('Initializing...').start();
    
    try {
      const indexer = new FileSystemIndex('./data');
      await indexer.initialize();
      const stats = indexer.getStats();
      spinner.succeed(`Ready: ${stats.embeddings} indexed items`);

      const limit = parseInt(options.limit);
      
      let results;
      if (options.type === 'semantic') {
        results = await indexer.semanticSearch(query, limit);
      } else {
        results = await indexer.exactSearch(query);
      }

      if (options.entityType) {
        const entityType = String(options.entityType).toLowerCase();
        const allowed = new Set(['method', 'class', 'enum']);
        if (!allowed.has(entityType)) {
          console.error(chalk.red(`Invalid --entity-type: ${options.entityType}. Use method|class|enum`));
          process.exit(1);
        }
        results = results.filter(result => result.type === entityType);
      }

      console.log(chalk.cyan(`\nFound ${results.length} results for "${query}":\n`));

      results.forEach((result, i) => {
        const displayName = result.type === 'method'
          ? `${result.className || '<unknown>'}.${result.methodName || '<unknown>'}`
          : result.type === 'class'
            ? (result.className || '<unknown>')
            : result.type === 'enum'
              ? (result.enumName || '<unknown>')
              : result.id;
        console.log(chalk.white.bold(`${i + 1}. ${result.type.toUpperCase()}: ${displayName}`));
        if (result.similarity) {
          console.log(chalk.gray(`   Similarity: ${(result.similarity * 100).toFixed(1)}%`));
        }
        console.log(chalk.gray(`   ${result.text.substring(0, 200)}...`));
        console.log();
      });

    } catch (error) {
      spinner.fail('Search failed');
      console.error(chalk.red(error));
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Show index statistics')
  .action(async () => {
    const spinner = ora('Loading stats...').start();
    
    try {
      const indexer = new FileSystemIndex('./data');
      await indexer.initialize();
      const stats = indexer.getStats();
      
      spinner.succeed('Stats loaded');
      
      console.log(chalk.blue.bold('\nIndex Statistics\n'));
      console.log(`Classes: ${chalk.green(stats.classes)}`);
      console.log(`Enums: ${chalk.green(stats.enums)}`);
      console.log(`Methods: ${chalk.green(stats.methods)}`);
      console.log(`Total embeddings: ${chalk.green(stats.embeddings)}`);
      
    } catch (error) {
      spinner.fail('Failed');
      console.error(chalk.red(error));
      process.exit(1);
    }
  });

program
  .command('verify')
  .description('Verify index quality and coverage')
  .option('--min-classes <number>', 'Minimum required classes', '100')
  .option('--min-methods <number>', 'Minimum required methods', '100')
  .option('--min-embeddings <number>', 'Minimum required embeddings', '500')
  .action(async (options) => {
    const spinner = ora('Running index quality checks...').start();

    try {
      const indexer = new FileSystemIndex('./data');
      await indexer.initialize();
      const stats = indexer.getStats();

      const minClasses = parseInt(options.minClasses, 10);
      const minMethods = parseInt(options.minMethods, 10);
      const minEmbeddings = parseInt(options.minEmbeddings, 10);

      const checks = [
        {
          name: 'Classes coverage',
          ok: stats.classes >= minClasses,
          value: `${stats.classes} / min ${minClasses}`
        },
        {
          name: 'Methods coverage',
          ok: stats.methods >= minMethods,
          value: `${stats.methods} / min ${minMethods}`
        },
        {
          name: 'Embeddings coverage',
          ok: stats.embeddings >= minEmbeddings,
          value: `${stats.embeddings} / min ${minEmbeddings}`
        }
      ];

      const failed = checks.filter(c => !c.ok);

      if (failed.length > 0) {
        spinner.fail('Index verification failed');
        console.log(chalk.red('\nFailed checks:'));
        for (const check of failed) {
          console.log(chalk.red(`  ✗ ${check.name}: ${check.value}`));
        }
        process.exit(1);
      }

      spinner.succeed('Index verification passed');
      console.log(chalk.green('\nAll checks passed:'));
      for (const check of checks) {
        console.log(chalk.green(`  ✓ ${check.name}: ${check.value}`));
      }
    } catch (error) {
      spinner.fail('Verification failed');
      console.error(chalk.red(error));
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate Enforce Script code')
  .argument('<file>', 'File to validate or "-" for stdin')
  .action(async (file) => {
    const { CodeValidator } = await import('../validator/CodeValidator.js');
    const validator = new CodeValidator();

    let code: string;
    
    if (file === '-') {
      // Read from stdin
      const chunks: Buffer[] = [];
      process.stdin.on('data', chunk => chunks.push(chunk));
      await new Promise(resolve => process.stdin.on('end', resolve));
      code = Buffer.concat(chunks).toString('utf-8');
    } else {
      if (!fs.existsSync(file)) {
        console.error(chalk.red(`File not found: ${file}`));
        process.exit(1);
      }
      code = fs.readFileSync(file, 'utf-8');
    }

    const result = validator.validate(code);

    console.log(chalk.blue.bold('\nValidation Results\n'));
    console.log(`Valid: ${result.valid ? chalk.green('Yes') : chalk.red('No')}`);

    if (result.errors.length > 0) {
      console.log(chalk.red(`\nErrors (${result.errors.length}):`));
      result.errors.forEach(err => {
        console.log(chalk.red(`  [${err.severity.toUpperCase()}] ${err.message}`));
        if (err.fix) {
          console.log(chalk.gray(`    Fix: ${err.fix}`));
        }
      });
    }

    if (result.suggestions.length > 0) {
      console.log(chalk.yellow(`\nSuggestions (${result.suggestions.length}):`));
      result.suggestions.forEach(s => {
        console.log(chalk.yellow(`  • ${s}`));
      });
    }

    if (result.vanillaAlternatives.length > 0) {
      console.log(chalk.cyan(`\nVanilla Alternatives (${result.vanillaAlternatives.length}):`));
      result.vanillaAlternatives.forEach(alt => {
        console.log(chalk.cyan(`  • Instead of: ${alt.customCode}`));
        console.log(chalk.cyan(`    Use: ${alt.vanillaFunction}`));
      });
    }
  });

program.parse();
