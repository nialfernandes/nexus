#!/usr/bin/env node
// The process's own streams and environment, handed to the command. Nothing else is here.

import { main } from "./command";

process.exitCode = await main(process.argv.slice(2), { env: process.env, stdout: process.stdout, stderr: process.stderr });
