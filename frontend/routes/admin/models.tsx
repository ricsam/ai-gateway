import { createFileRoute } from "@richie-router/react";
import { useState } from "react";
import { IconBrain, IconDatabase, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { api, queryClient } from "../../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Form = { modelId: string; name: string; description: string; input: string; output: string; context: string; maxOutput: string; region: string; thinking: boolean; cache: boolean; enabled: boolean };
const blank: Form = { modelId: "", name: "", description: "", input: "0", output: "0", context: "", maxOutput: "32000", region: "", thinking: false, cache: false, enabled: true };
export const Route = createFileRoute("/admin/models")({ component: Models });

function Models() {
  const { data } = api.adminListModels.useQuery({ queryKey: ["adminListModels"], queryData: {} });
  const models = data?.payload ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const create = api.adminCreateModel.useMutation(); const update = api.adminUpdateModel.useMutation(); const remove = api.adminDeleteModel.useMutation();
  const open = (model?: typeof models[number]) => { setEditing(model?.id ?? "new"); setForm(model ? { modelId: model.modelId, name: model.name, description: model.description ?? "", input: String(model.inputPricePerMTok), output: String(model.outputPricePerMTok), context: String(model.contextWindow ?? ""), maxOutput: String(model.maxOutputTokens), region: model.region ?? "", thinking: model.thinking, cache: model.managedCache, enabled: model.enabled } : blank); };
  const save = async () => {
    const body = { modelId: form.modelId, name: form.name, description: form.description || undefined, inputPricePerMTok: Number(form.input), outputPricePerMTok: Number(form.output), contextWindow: form.context ? Number(form.context) : undefined, maxOutputTokens: Number(form.maxOutput), region: form.region, thinking: form.thinking, managedCache: form.cache, enabled: form.enabled };
    if (editing === "new") await create.mutateAsync({ body }); else await update.mutateAsync({ params: { id: editing! }, body });
    setEditing(null); void queryClient.invalidateQueries({ queryKey: ["adminListModels"] }); void queryClient.invalidateQueries({ queryKey: ["getModels"] });
  };
  return <div className="space-y-4"><div className="flex items-center justify-between"><div><h1 className="text-2xl font-semibold">Models</h1><p className="text-sm text-muted-foreground">The enabled Bedrock catalog is shared by the API and playground.</p></div><Button onClick={() => open()}><IconPlus /> Add model</Button></div>
    <div className="rounded-lg border overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className="text-left p-3">Model</th><th className="text-left">Bedrock ID</th><th>Input / MTok</th><th>Output / MTok</th><th>Features</th><th>Status</th><th /></tr></thead><tbody>{models.map((model) => <tr key={model.id} className="border-t"><td className="p-3 font-medium">{model.name}</td><td className="font-mono text-xs">{model.modelId}</td><td className="text-center">${model.inputPricePerMTok}</td><td className="text-center">${model.outputPricePerMTok}</td><td><div className="flex justify-center gap-2">{model.thinking && <IconBrain size={16} />}{model.managedCache && <IconDatabase size={16} />}</div></td><td className="text-center"><Badge variant={model.enabled ? "default" : "secondary"}>{model.enabled ? "Enabled" : "Disabled"}</Badge></td><td className="p-2"><Button variant="ghost" size="icon" onClick={() => open(model)}><IconPencil /></Button><Button variant="ghost" size="icon" onClick={async () => { await remove.mutateAsync({ params: { id: model.id } }); void queryClient.invalidateQueries({ queryKey: ["adminListModels"] }); }}><IconTrash /></Button></td></tr>)}</tbody></table></div>
    <Dialog open={!!editing} onOpenChange={(value) => !value && setEditing(null)}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{editing === "new" ? "Add model" : "Edit model"}</DialogTitle></DialogHeader><div className="grid grid-cols-2 gap-4">
      <Field label="Bedrock model ID"><Input value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} /></Field><Field label="Display name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <div className="col-span-2"><Field label="Description"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></div>
      <Field label="Input $/MTok"><Input type="number" value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} /></Field><Field label="Output $/MTok"><Input type="number" value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} /></Field>
      <Field label="Context window"><Input type="number" value={form.context} onChange={(e) => setForm({ ...form, context: e.target.value })} /></Field><Field label="Max output tokens"><Input type="number" value={form.maxOutput} onChange={(e) => setForm({ ...form, maxOutput: e.target.value })} /></Field>
      <Field label="AWS region"><Input value={form.region} placeholder="Uses AWS_REGION when empty" onChange={(e) => setForm({ ...form, region: e.target.value })} /></Field>
      <div className="flex flex-col gap-2 pt-6">{(["thinking", "cache", "enabled"] as const).map((key) => <label key={key} className="flex gap-2 text-sm capitalize"><input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />{key === "cache" ? "Managed cache" : key}</label>)}</div>
      <Button className="col-span-2" onClick={save} disabled={!form.modelId || !form.name}>Save model</Button>
    </div></DialogContent></Dialog>
  </div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }
