#!/usr/bin/env node
// Entry point for DayZ MCP Server

import { DayZMCP } from './DayZMCP.js';

async function main() {
  const server = new DayZMCP();
  await server.initialize();
  await server.run();
}

main().catch(console.error);
