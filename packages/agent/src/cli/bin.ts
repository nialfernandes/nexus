#!/usr/bin/env node
// The process's own streams, environment and clock, handed to the command. Nothing else is here.

import { main } from "./main";

const code = await main(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
});
process.exitCode = code;
process.stdin.pause();
