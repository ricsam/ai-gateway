import { createFileRoute, Link } from "@richie-router/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconBrain, IconCoins, IconPhotoPlus, IconPlayerStop, IconRefresh, IconSend, IconX } from "@tabler/icons-react";
import env from "@/env";
import type { ReasoningEffort } from "@/shared/reasoning";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, queryClient } from "../../api";
import { AppShell } from "../../ui/app-shell";
import { MessageResponse } from "../../ui/components/message";

type Attachment = { id: string; name: string; dataUrl: string };
type ChatMessage = { role: "user" | "assistant"; content: string; images?: Attachment[]; reasoning?: string };
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type CreditUsage = { actual_cost: number; credits_charged: number; balance_after: number; partially_charged: boolean };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024);
const MAX_IMAGES = 20;
const EFFORT_LABELS: Record<ReasoningEffort, string> = { none: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

function formatCredits(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

/** OpenAI content for a playground message: plain text, or text plus image parts. */
function toApiMessage(message: ChatMessage) {
  if (message.role === "assistant" || !message.images?.length) return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: [
      ...(message.content ? [{ type: "text", text: message.content }] : []),
      ...message.images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
    ],
  };
}

export const Route = createFileRoute("/chat/")({ component: Playground });

function Playground() {
  const { data } = api.getModels.useQuery({ queryKey: ["getModels"], queryData: {} });
  const profileQuery = api.getProfile.useQuery({ queryKey: ["getProfile"], queryData: {} });
  const models = data?.payload ?? [];
  const profile = profileQuery.data?.payload;
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [effort, setEffort] = useState<ReasoningEffort | "default">("default");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [creditUsage, setCreditUsage] = useState<CreditUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (model || !models[0]) return;
    const saved = localStorage.getItem("chat-last-model");
    setModel(saved && models.some((entry) => entry.modelId === saved) ? saved : models[0].modelId);
  }, [models, model]);
  useEffect(() => { if (model) localStorage.setItem("chat-last-model", model); }, [model]);
  const selected = useMemo(() => models.find((entry) => entry.modelId === model), [models, model]);
  const efforts = selected?.reasoningEfforts ?? [];
  useEffect(() => { if (effort !== "default" && !efforts.includes(effort)) setEffort("default"); }, [efforts, effort]);

  const addImages = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    const unsupported = images.find((file) => !IMAGE_TYPES.includes(file.type));
    if (unsupported) { setError(`${unsupported.name || "Image"} is not a PNG, JPEG, GIF, or WebP image`); return; }
    const oversized = images.find((file) => file.size > MAX_IMAGE_BYTES);
    if (oversized) { setError(`${oversized.name || "Image"} is larger than 3.75 MB`); return; }
    if (attachments.length + images.length > MAX_IMAGES) { setError(`Attach at most ${MAX_IMAGES} images per message`); return; }
    try {
      const added = await Promise.all(images.map(async (file) => ({ id: crypto.randomUUID(), name: file.name || "Pasted image", dataUrl: await readAsDataUrl(file) })));
      setAttachments((current) => [...current, ...added]);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not read image"); }
  };

  const reset = () => { abortRef.current?.abort(); setMessages([]); setUsage(null); setCreditUsage(null); setError(null); setInput(""); setAttachments([]); };
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !!model;
  const submit = async () => {
    if (!canSend || streaming) return;
    const userMessage: ChatMessage = { role: "user", content: input.trim(), ...(attachments.length && { images: attachments }) };
    const outgoing = [...messages, userMessage];
    setMessages([...outgoing, { role: "assistant", content: "" }]);
    setInput(""); setAttachments([]); setError(null); setStreaming(true); setUsage(null); setCreditUsage(null);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const response = await fetch(`${env.BASE_URL}/api/playground/chat/completions`, {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, stream: true, messages: outgoing.map(toApiMessage),
          ...(!selected?.alias && effort !== "default" && { reasoning_effort: effort }),
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
          const chunk = JSON.parse(dataLine.slice(6)) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>; usage?: Usage; credit_usage?: CreditUsage };
          const text = chunk.choices?.[0]?.delta?.content;
          const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
          if (text || reasoning) setMessages((current) => current.map((entry, index) => index === current.length - 1 ? { ...entry, content: entry.content + (text ?? ""), reasoning: (entry.reasoning ?? "") + (reasoning ?? "") } : entry));
          if (chunk.usage) setUsage(chunk.usage);
          if (chunk.credit_usage) setCreditUsage(chunk.credit_usage);
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["getProfile"] });
      setStreaming(false);
      abortRef.current = null;
    }
  };

  return (
    <AppShell>
      <main className="max-w-5xl mx-auto p-5 md:p-8 flex flex-col min-h-[calc(100vh-4rem)]">
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="mr-auto"><h1 className="text-2xl font-semibold">Model playground</h1><p className="text-sm text-muted-foreground">Usage is metered against your credits. <Link to="/models" className="underline">Model pricing</Link></p></div>
          <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm" title="Available credit balance"><IconCoins size={16} className="text-muted-foreground" /><span className="text-muted-foreground">Balance</span><span className="font-mono font-medium">{creditUsage ? formatCredits(creditUsage.balance_after) : profile ? formatCredits(profile.creditBalance) : "—"}</span></div>
          <Select value={model} onValueChange={setModel}><SelectTrigger className="w-64" aria-label="Model"><SelectValue placeholder="Choose a model" /></SelectTrigger><SelectContent>{models.map((entry) => <SelectItem key={entry.modelId} value={entry.modelId}>{entry.displayName}</SelectItem>)}</SelectContent></Select>
          {selected?.alias ? <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs" title="Reasoning is pinned by this alias and cannot be overridden"><span className="flex items-center gap-2 font-medium"><IconBrain size={16} />Pinned alias settings</span><span>Thinking {selected.alias.thinking ? "on" : "off"} · Effort {selected.alias.effort ? EFFORT_LABELS[selected.alias.effort] : "provider default"}</span><span className="block font-mono text-muted-foreground">{selected.alias.modelId}</span></div> : <div className="flex items-center gap-2 text-sm" title={efforts.length ? "Reasoning effort sent as reasoning_effort" : "This model does not have reasoning controls enabled"}>
            <IconBrain size={16} />
            <Select value={effort} onValueChange={(value) => setEffort(value as ReasoningEffort | "default")} disabled={!efforts.length}>
              <SelectTrigger className="w-40" aria-label="Reasoning effort"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{selected?.defaultReasoningEffort ? `Default (${EFFORT_LABELS[selected.defaultReasoningEffort]})` : "Default"}</SelectItem>
                {efforts.map((level) => <SelectItem key={level} value={level}>{EFFORT_LABELS[level]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>}
          <Button variant="outline" size="icon" onClick={reset} title="Reset"><IconRefresh /></Button>
          </div>
        </div>

        <section className="flex-1 rounded-xl border bg-card overflow-hidden flex flex-col min-h-[520px]">
          <div className="flex-1 overflow-y-auto p-5 md:p-8 space-y-6">
            {!messages.length && <div className="h-full grid place-items-center text-center text-muted-foreground"><div><p className="font-medium text-foreground">Ready to test</p><p className="text-sm">Messages and images stay in this browser tab and are not saved.</p></div></div>}
            {messages.map((message, index) => <div key={index} className={message.role === "user" ? "ml-auto max-w-[80%] rounded-2xl bg-primary text-primary-foreground px-4 py-3" : "max-w-[90%] prose dark:prose-invert"}>{message.role === "assistant" ? <div>{message.reasoning && <details className="mb-3 rounded-lg border bg-muted/30 p-3 text-sm" open={streaming && index === messages.length - 1}><summary className="cursor-pointer font-medium">Reasoning</summary><div className="mt-2 text-muted-foreground"><MessageResponse>{message.reasoning}</MessageResponse></div></details>}<MessageResponse>{message.content || (streaming ? "Thinking..." : "No response")}</MessageResponse></div> : <div className="space-y-2">{message.images?.length ? <div className="flex flex-wrap gap-2">{message.images.map((image) => <img key={image.id} src={image.dataUrl} alt={image.name} className="max-h-40 max-w-full rounded-lg border border-primary-foreground/20 object-contain" />)}</div> : null}{message.content && <p className="whitespace-pre-wrap">{message.content}</p>}</div>}</div>)}
          </div>
          <div
            className={`border-t p-4 space-y-3 ${dragging ? "bg-primary/5 outline-2 outline-dashed outline-primary -outline-offset-4" : ""}`}
            onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragging(true); } }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void addImages(Array.from(event.dataTransfer.files)); }}
          >
            {error && <p className="text-sm text-destructive">{error}</p>}
            {(usage || creditUsage) && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
              {usage && <span><strong className="font-medium text-foreground">{usage.total_tokens.toLocaleString()}</strong> tokens · {usage.prompt_tokens.toLocaleString()} input · {usage.completion_tokens.toLocaleString()} output</span>}
              {creditUsage && <><span className="hidden sm:inline">·</span><span><strong className="font-medium text-foreground">{formatCredits(creditUsage.credits_charged)}</strong> credits deducted · {formatCredits(creditUsage.balance_after)} remaining{creditUsage.partially_charged ? " (balance exhausted)" : ""}</span></>}
              {usage && !creditUsage && streaming && <span>· Settling credits…</span>}
            </div>}
            {attachments.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Attached images">
              {attachments.map((image) => <div key={image.id} className="relative"><img src={image.dataUrl} alt={image.name} className="h-16 w-16 rounded-md border object-cover" /><button type="button" className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full border bg-background text-foreground shadow" title={`Remove ${image.name}`} aria-label={`Remove ${image.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== image.id))}><IconX size={12} /></button></div>)}
            </div>}
            <div className="flex gap-3 items-end">
              <input ref={fileInputRef} type="file" accept={IMAGE_TYPES.join(",")} multiple className="sr-only" aria-label="Attach images" onChange={(event) => { void addImages(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
              <Button type="button" variant="outline" size="icon" className="h-11 w-11" title="Attach images (PNG, JPEG, GIF, WebP)" disabled={streaming} onClick={() => fileInputRef.current?.click()}><IconPhotoPlus /></Button>
              <Textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Send a message to the selected model... (paste or drop images to attach)" className="min-h-20 resize-none"
                onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); void addImages(files); } }}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
              <Button size="icon" className="h-11 w-11" title={streaming ? "Stop" : "Send"} disabled={streaming ? false : !canSend} onClick={streaming ? () => abortRef.current?.abort() : submit}>{streaming ? <IconPlayerStop /> : <IconSend />}</Button>
            </div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
