import { createFileRoute } from "@richie-router/react";
import { useState } from "react";
import { IconBrain, IconDatabase, IconFlask, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { api, queryClient } from "../../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Form = {
  modelId: string; name: string; description: string; input: string; output: string;
  cacheWrite5m: string; cacheWrite1h: string; cacheRead: string;
  context: string; maxOutput: string; region: string; thinking: boolean; cache: boolean; enabled: boolean;
};
const blank: Form = { modelId: "", name: "", description: "", input: "0", output: "0", cacheWrite5m: "", cacheWrite1h: "", cacheRead: "", context: "", maxOutput: "32000", region: "", thinking: false, cache: false, enabled: true };
export const Route = createFileRoute("/admin/models")({ component: Models });

function Models() {
  const { data } = api.adminListModels.useQuery({ queryKey: ["adminListModels"], queryData: {} });
  const models = data?.payload ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [testPrompt, setTestPrompt] = useState("Reply with OK");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = api.adminCreateModel.useMutation(); const update = api.adminUpdateModel.useMutation(); const remove = api.adminDeleteModel.useMutation(); const test = api.adminTestModel.useMutation();
  const open = (model?: typeof models[number]) => {
    setEditing(model?.id ?? "new"); setTestResult(null); setError(null);
    setForm(model ? {
      modelId: model.modelId, name: model.name, description: model.description ?? "", input: String(model.inputPricePerMTok), output: String(model.outputPricePerMTok),
      cacheWrite5m: model.cacheWrite5mPricePerMTok == null ? "" : String(model.cacheWrite5mPricePerMTok), cacheWrite1h: model.cacheWrite1hPricePerMTok == null ? "" : String(model.cacheWrite1hPricePerMTok), cacheRead: model.cacheReadPricePerMTok == null ? "" : String(model.cacheReadPricePerMTok),
      context: String(model.contextWindow ?? ""), maxOutput: String(model.maxOutputTokens), region: model.region ?? "", thinking: model.thinking, cache: model.managedCache, enabled: model.enabled,
    } : blank);
  };
  const body = () => ({
    modelId: form.modelId.trim(), name: form.name.trim(), description: form.description || undefined,
    inputPricePerMTok: Number(form.input), outputPricePerMTok: Number(form.output),
    cacheWrite5mPricePerMTok: form.cacheWrite5m ? Number(form.cacheWrite5m) : undefined,
    cacheWrite1hPricePerMTok: form.cacheWrite1h ? Number(form.cacheWrite1h) : undefined,
    cacheReadPricePerMTok: form.cacheRead ? Number(form.cacheRead) : undefined,
    contextWindow: form.context ? Number(form.context) : undefined, maxOutputTokens: Number(form.maxOutput), region: form.region.trim(),
    thinking: form.thinking, managedCache: form.cache, enabled: form.enabled,
  });
  const save = async () => {
    setError(null);
    try {
      if (editing === "new") await create.mutateAsync({ body: body() }); else await update.mutateAsync({ params: { id: editing! }, body: body() });
      setEditing(null); await queryClient.invalidateQueries({ queryKey: ["adminListModels"] }); await queryClient.invalidateQueries({ queryKey: ["getModels"] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save model"); }
  };
  const runTest = async () => {
    setError(null); setTestResult(null);
    try {
      const result = await test.mutateAsync({ body: { modelId: form.modelId, prompt: testPrompt, inputPricePerMTok: Number(form.input), outputPricePerMTok: Number(form.output), region: form.region || undefined } });
      if (result.status >= 400) throw new Error("Model test failed");
      setTestResult(`${result.payload.response || "(empty response)"} · ${result.payload.inputTokens} input / ${result.payload.outputTokens} output tokens · $${result.payload.cost.toFixed(6)}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Model test failed"); }
  };
  return <div className="space-y-4"><div className="flex items-center justify-between"><div><h1 className="text-2xl font-semibold">Models</h1><p className="text-sm text-muted-foreground">The enabled Bedrock catalog and pricing are shared by the API and playground.</p></div><Button onClick={() => open()}><IconPlus />Add model</Button></div>
    {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <div className="rounded-lg border overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead className="bg-muted/50"><tr><th className="text-left p-3">Model</th><th className="text-left">Bedrock ID</th><th>Input / MTok</th><th>Output / MTok</th><th>Region</th><th>Features</th><th>Status</th><th /></tr></thead><tbody>{models.map((model) => <tr key={model.id} className="border-t"><td className="p-3 font-medium">{model.name}</td><td className="font-mono text-xs">{model.modelId}</td><td className="text-center">${model.inputPricePerMTok}</td><td className="text-center">${model.outputPricePerMTok}</td><td className="text-center">{model.region || "default"}</td><td><div className="flex justify-center gap-2">{model.thinking && <IconBrain size={16} />}{model.managedCache && <IconDatabase size={16} />}</div></td><td className="text-center"><Badge variant={model.enabled ? "default" : "secondary"}>{model.enabled ? "Enabled" : "Disabled"}</Badge></td><td className="p-2"><Button variant="ghost" size="icon" title="Edit model" onClick={() => open(model)}><IconPencil /></Button><Button variant="ghost" size="icon" title="Delete model" onClick={async () => { if (!window.confirm(`Delete ${model.name}?`)) return; await remove.mutateAsync({ params: { id: model.id } }); void queryClient.invalidateQueries({ queryKey: ["adminListModels"] }); }}><IconTrash /></Button></td></tr>)}</tbody></table></div>
    <Dialog open={!!editing} onOpenChange={(value) => !value && setEditing(null)}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editing === "new" ? "Add model" : "Edit model"}</DialogTitle></DialogHeader><div className="grid gap-4 sm:grid-cols-2">
      <Field label="Bedrock model ID"><Input value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} /></Field><Field label="Display name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <div className="sm:col-span-2"><Field label="Description"><Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field></div>
      <Field label="Input $/MTok"><Input type="number" min="0" step="0.000001" value={form.input} onChange={(event) => setForm({ ...form, input: event.target.value })} /></Field><Field label="Output $/MTok"><Input type="number" min="0" step="0.000001" value={form.output} onChange={(event) => setForm({ ...form, output: event.target.value })} /></Field>
      <Field label="Cache write 5m $/MTok"><Input type="number" min="0" step="0.000001" value={form.cacheWrite5m} onChange={(event) => setForm({ ...form, cacheWrite5m: event.target.value })} /></Field><Field label="Cache write 1h $/MTok"><Input type="number" min="0" step="0.000001" value={form.cacheWrite1h} onChange={(event) => setForm({ ...form, cacheWrite1h: event.target.value })} /></Field>
      <Field label="Cache read $/MTok"><Input type="number" min="0" step="0.000001" value={form.cacheRead} onChange={(event) => setForm({ ...form, cacheRead: event.target.value })} /></Field><Field label="AWS region override"><Input value={form.region} placeholder="Uses configured default when empty" onChange={(event) => setForm({ ...form, region: event.target.value })} /></Field>
      <Field label="Context window"><Input type="number" min="1" value={form.context} onChange={(event) => setForm({ ...form, context: event.target.value })} /></Field><Field label="Max output tokens"><Input type="number" min="1" value={form.maxOutput} onChange={(event) => setForm({ ...form, maxOutput: event.target.value })} /></Field>
      <div className="flex flex-wrap gap-4 sm:col-span-2">{(["thinking", "cache", "enabled"] as const).map((key) => <label key={key} className="flex items-center gap-2 text-sm capitalize"><input className="size-4 accent-primary" type="checkbox" checked={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.checked })} />{key === "cache" ? "Managed cache" : key}</label>)}</div>
      <div className="space-y-2 rounded-lg border p-4 sm:col-span-2"><Label>Test model before saving</Label><div className="flex gap-2"><Input value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} /><Button variant="outline" onClick={() => void runTest()} disabled={test.isPending || !form.modelId.trim()}><IconFlask />Test</Button></div>{testResult && <p className="text-sm text-green-700 dark:text-green-400">{testResult}</p>}</div>
    </div><DialogFooter><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => void save()} disabled={!form.modelId.trim() || !form.name.trim() || create.isPending || update.isPending}>Save model</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }
