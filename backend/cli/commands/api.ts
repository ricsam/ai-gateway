import { readPayload } from "../client";
import { CliError, UsageError } from "../errors";
import type { Command } from "../framework";
import { stringOption } from "../inputs";
import { printJson } from "../output";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export const apiCommand: Command = {
  name: "api",
  summary: "Send a request to the management API and print the response",
  usage: "<method> <path>",
  details: `<path> is relative to /management/v1, such as /users?search=alice or /analytics/tokens?timeRange=day.
Prints the response body (JSON is pretty-printed) and exits with 1 when the API answers with an error.
The routes are listed by: aigctl api GET /openapi.json`,
  options: {
    data: { type: "string", short: "d", value: "<body>", description: "Request body: JSON text, @file, or @- for standard input" },
    "content-type": { type: "string", value: "<type>", description: "Content type of the body (default application/json)" },
  },
  examples: [
    "aigctl api GET '/audit-events?limit=5'",
    "aigctl api PATCH /users/<id> -d '{\"defaultMonthlyCredits\": 100}'",
    "kubectl exec -i deploy/ai-gateway-ai-gateway -- aigctl api POST /auth/providers -d @- < provider.json",
  ],
  async run(context) {
    const method = context.args[0]!.toUpperCase();
    if (!METHODS.includes(method)) throw new UsageError(`The method must be one of ${METHODS.join(", ")}`, context.commandName);
    const path = context.args[1]!;
    const data = stringOption(context.options.data);
    const contentType = stringOption(context.options["content-type"]) ?? "application/json";
    let bytes: Uint8Array | undefined;
    if (data !== undefined) {
      try {
        bytes = data === "@-" ? await context.io.readStdin() : data.startsWith("@") ? await context.io.readFile(data.slice(1)) : new TextEncoder().encode(data);
      } catch (error) {
        throw new CliError(`Could not read ${data.slice(1)}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (contentType === "application/json") {
        try { JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new UsageError("The request body is not valid JSON", context.commandName); }
      }
    }
    const client = await context.client();
    const response = await client.send(method, path, bytes ? { bytes, contentType } : {});
    const payload = await readPayload(response);
    if (typeof payload === "string") context.io.out(payload.endsWith("\n") ? payload : `${payload}\n`);
    else if (payload !== undefined) printJson(context.io, payload);
    if (response.ok) return 0;
    context.io.err(`aigctl: ${method} ${path} answered HTTP ${response.status}\n`);
    return 1;
  },
};
