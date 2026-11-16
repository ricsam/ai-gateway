#!/usr/bin/env bun
// aigctl: the AI Gateway management CLI. In the container image it is on the
// PATH (bin/aigctl); in a checkout, run `bun run aigctl -- <command>`.
import { createClient } from "./client";
import { runProgram } from "./framework";
import { processIo } from "./io";
import { program } from "./program";

const io = processIo();
const exitCode = await runProgram(program, process.argv.slice(2), { io, createClient });
await io.flush();
process.exit(exitCode);
