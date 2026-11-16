import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { CliError } from "./errors";
import { terminalSafe } from "./text";

/** Everything a command reads from or writes to its environment, so tests can replace it. */
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The pod name inside Kubernetes. */
  readonly hostname: string;
  /** Whether standard input is a terminal that can answer prompts (kubectl exec -it). */
  readonly interactive: boolean;
  /** Results: tables, JSON, created keys and generated passwords. */
  out(text: string): void;
  /** Messages and prompts. */
  err(text: string): void;
  /** Reads one line from the terminal; hidden input (passwords, secrets) is not echoed. */
  prompt(question: string, options?: { hidden?: boolean }): Promise<string>;
  readStdin(): Promise<Uint8Array>;
  readFile(path: string): Promise<Uint8Array>;
  /** Resolves once everything written has reached the operating system. */
  flush(): Promise<void>;
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => { stream.write("", () => resolve()); });
}

export function processIo(): Io {
  // Input typed ahead of a prompt (or pasted with it) belongs to the next prompt.
  let pending = "";
  let skipLineFeed = false;

  function promptTerminal(question: string, hidden: boolean): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) return Promise.reject(new CliError("Cannot prompt for input: standard input is not a terminal"));
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise<string>((resolve, reject) => {
      let line = "";
      const finish = (error?: CliError) => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write("\n");
        if (error) reject(error); else resolve(line);
      };
      const consume = (text: string): boolean => {
        for (let index = 0; index < text.length; index++) {
          const character = text[index]!;
          if (skipLineFeed) {
            skipLineFeed = false;
            if (character === "\n") continue;
          }
          if (character === "\r" || character === "\n") {
            skipLineFeed = character === "\r";
            pending = text.slice(index + 1);
            finish();
            return true;
          }
          if (character === "\u0003" || (character === "\u0004" && !line)) {
            pending = "";
            finish(new CliError("Cancelled", 130));
            return true;
          }
          if (character === "\u007f" || character === "\b") {
            if (line) {
              line = Array.from(line).slice(0, -1).join("");
              if (!hidden) process.stderr.write("\b \b");
            }
            continue;
          }
          if (character === "\u0015") {
            if (!hidden) process.stderr.write("\b \b".repeat(Array.from(line).length));
            line = "";
            continue;
          }
          if (character === "\u001b") {
            // Skip an escape sequence, such as an arrow key.
            index++;
            if (text[index] === "[" || text[index] === "O") {
              index++;
              while (index < text.length && !/[A-Za-z~]/.test(text[index]!)) index++;
            }
            continue;
          }
          if (character < " ") continue;
          line += character;
          if (!hidden) process.stderr.write(character);
        }
        return false;
      };
      const onData = (chunk: string | Buffer) => { consume(typeof chunk === "string" ? chunk : chunk.toString("utf8")); };
      if (pending) {
        const text = pending;
        pending = "";
        if (consume(text)) return;
      }
      stdin.on("data", onData);
    });
  }

  return {
    env: process.env,
    hostname: hostname(),
    interactive: Boolean(process.stdin.isTTY),
    // Every result and message passes terminalSafe, so values from the database
    // (names, labels, error texts) cannot send escape sequences to the terminal.
    out: (text) => { process.stdout.write(terminalSafe(text)); },
    err: (text) => { process.stderr.write(terminalSafe(text)); },
    prompt: (question, options) => promptTerminal(terminalSafe(question), options?.hidden ?? false),
    readStdin: async () => new Uint8Array(await Bun.stdin.arrayBuffer()),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    flush: async () => { await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]); },
  };
}
