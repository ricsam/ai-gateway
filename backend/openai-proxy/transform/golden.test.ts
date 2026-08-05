import { describe, expect, test } from "bun:test";
import { transformRequest } from "./request";
import { transformResponse } from "./response";
import { transformStream } from "./stream";
import { addConverseCachePoints } from "./cache-converse";
import { addInvokeCacheControl } from "./cache-invoke";
const fixture = await Bun.file(new URL("../__fixtures__/historical-transform-golden.json", import.meta.url)).json() as any;
describe("historical golden transformations", () => {
  test("OpenAI request and Bedrock response match historical fixtures", () => {
    expect(transformRequest(fixture.request.openai)).toEqual(fixture.request.bedrock);
    const response = transformResponse(fixture.response.bedrock, "fixture-model", "chatcmpl_fixture");
    expect({ ...response, created: 0 }).toEqual({ ...fixture.response.openai, created: 0 });
  });
  test("managed cache placement matches historical fixtures", () => {
    expect(addConverseCachePoints(fixture.request.bedrock)).toEqual(fixture.cache.converse);
    expect(addInvokeCacheControl({ anthropic_version: "bedrock-2023-05-31", system: "system", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })).toEqual(fixture.cache.invoke);
  });
  test("stream role, tools, finish and usage ordering match historical fixtures", async () => {
    const events: any[] = [
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_2", name: "lookup" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"q"' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: ':"y"}' } } } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 12, outputTokens: 4 } } },
    ];
    const output: string[] = [];
    for await (const frame of transformStream((async function* () { for (const event of events) yield event; })(), "fixture-model", "chatcmpl_fixture")) output.push(frame);
    // Timestamps are generated at runtime; all other chunk semantics/order are stable.
    expect(output.length).toBe(fixture.stream.length);
    const parse = (frame: string) => frame.includes("[DONE]") ? "DONE" : JSON.parse(frame.slice(6)).choices;
    expect(output.map(parse)).toEqual(fixture.stream.map(parse));
  });
});
