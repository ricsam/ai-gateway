import { createFileRoute, Link } from "@richie-router/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconBrain, IconPlayerStop, IconRefresh, IconSend } from "@tabler/icons-react";
import env from "@/env";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, queryClient } from "../../api";
import { AppShell } from "../../ui/app-shell";
import { MessageResponse } from "../../ui/components/message";

type ChatMessage = { role: "user" | "assistant"; content: string; reasoning?: string };
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export const Route = createFileRoute("/chat/")({ component: Playground });

function Playground() {
  const { data } = api.getModels.useQuery({ queryKey: ["getModels"], queryData: {} });
  const models = data?.payload ?? [];
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (model || !models[0]) return;
    const saved = localStorage.getItem("chat-last-model");
    setModel(saved && models.some((entry) => entry.modelId === saved) ? saved : models[0].modelId);
  }, [models, model]);
  useEffect(() => { if (model) localStorage.setItem("chat-last-model", model); }, [model]);
  const selected = useMemo(() => models.find((entry) => entry.modelId === model), [models, model]);
  useEffect(() => { if (!selected?.thinking) setThinking(false); }, [selected]);

  const reset = () => { abortRef.current?.abort(); setMessages([]); setUsage(null); setError(null); setInput(""); };
  const submit = async () => {
    if (!input.trim() || !model || streaming) return;
    const userMessage: ChatMessage = { role: "user", content: input.trim() };
    const outgoing = [...messages, userMessage];
    setMessages([...outgoing, { role: "assistant", content: "" }]);
    setInput(""); setError(null); setStreaming(true); setUsage(null);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const response = await fetch(`${env.BASE_URL}/api/playground/chat/completions`, {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, stream: true, messages: outgoing,
          ...(thinking && { reasoning_effort: "high" }),
        }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n"); buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine || dataLine === "data: [DONE]") continue;
          const chunk = JSON.parse(dataLine.slice(6)) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>; usage?: Usage };
          const text = chunk.choices?.[0]?.delta?.content;
          const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
          if (text || reasoning) setMessages((current) => current.map((entry, index) => index === current.length - 1 ? { ...entry, content: entry.content + (text ?? ""), reasoning: (entry.reasoning ?? "") + (reasoning ?? "") } : entry));
          if (chunk.usage) setUsage(chunk.usage);
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["getProfile"] });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Request failed");
    } finally { setStreaming(false); abortRef.current = null; }
  };

  return (
    <AppShell>
      <main className="max-w-5xl mx-auto p-5 md:p-8 flex flex-col min-h-[calc(100vh-4rem)]">
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="mr-auto"><h1 className="text-2xl font-semibold">Model playground</h1><p className="text-sm text-muted-foreground">A stateless chat for testing configured models. <Link to="/models" className="underline">Model pricing</Link></p></div>
          <Select value={model} onValueChange={setModel}><SelectTrigger className="w-64"><SelectValue placeholder="Choose a model" /></SelectTrigger><SelectContent>{models.map((entry) => <SelectItem key={entry.modelId} value={entry.modelId}>{entry.displayName}</SelectItem>)}</SelectContent></Select>
          <div className="flex items-center gap-2 text-sm"><IconBrain size={16} /><Switch checked={thinking} disabled={!selected?.thinking} onCheckedChange={setThinking} />Thinking</div>
          <Button variant="outline" size="icon" onClick={reset} title="Reset"><IconRefresh /></Button>
        </div>

        <section className="flex-1 rounded-xl border bg-card overflow-hidden flex flex-col min-h-[520px]">
          <div className="flex-1 overflow-y-auto p-5 md:p-8 space-y-6">
            {!messages.length && <div className="h-full grid place-items-center text-center text-muted-foreground"><div><p className="font-medium text-foreground">Ready to test</p><p className="text-sm">Messages stay in this browser tab and are not saved.</p></div></div>}
            {messages.map((message, index) => <div key={index} className={message.role === "user" ? "ml-auto max-w-[80%] rounded-2xl bg-primary text-primary-foreground px-4 py-3" : "max-w-[90%] prose dark:prose-invert"}>{message.role === "assistant" ? <div>{message.reasoning && <details className="mb-3 rounded-lg border bg-muted/30 p-3 text-sm" open={streaming && index === messages.length - 1}><summary className="cursor-pointer font-medium">Reasoning</summary><div className="mt-2 text-muted-foreground"><MessageResponse>{message.reasoning}</MessageResponse></div></details>}<MessageResponse>{message.content || (streaming ? "Thinking..." : "No response")}</MessageResponse></div> : message.content}</div>)}
          </div>
          <div className="border-t p-4 space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {usage && <p className="text-xs text-muted-foreground">{usage.prompt_tokens.toLocaleString()} input · {usage.completion_tokens.toLocaleString()} output · {usage.total_tokens.toLocaleString()} total tokens</p>}
            <div className="flex gap-3 items-end"><Textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Send a message to the selected model..." className="min-h-20 resize-none" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><Button size="icon" className="h-11 w-11" disabled={streaming ? false : !input.trim() || !model} onClick={streaming ? () => abortRef.current?.abort() : submit}>{streaming ? <IconPlayerStop /> : <IconSend />}</Button></div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
