#!/usr/bin/env bun

import { runClasiCli } from "../src/cli.ts";

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runClasiCli(args);
}

if (import.meta.main) {
  process.exitCode = await main();
}
