import { createFileRoute } from "@richie-router/react";
import { useState } from "react";
import { apiErrorMessage } from "../../lib/api-error";
import { api, queryClient } from "../../api";
import { getAliasCapabilities, validateAliasSettings } from "@/shared/alias-options";
import type { EffortLevel } from "@/shared/reasoning";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/aliases")({ component: Aliases });
type Form = { modelId: string; name: string; description: string; upstreamModelId: string; thinking: boolean; effort: EffortLevel | null; enabled: boolean };
const blank: Form = { modelId: "", name: "", description: "", upstreamModelId: "", thinking: false, effort: null, enabled: true };
const selectClass = "h-9 w-full rounded-md border bg-background px-3 text-sm";
function Aliases() {
  const aliasesQuery = api.adminListAliases.useQuery({ queryKey: ["adminListAliases"], queryData: {} });
  const modelsQuery = api.adminListModels.useQuery({ queryKey: ["adminListModels"], queryData: {} });
  const aliases = aliasesQuery.data?.payload ?? [];
  const models = modelsQuery.data?.payload ?? [];
  const create = api.adminCreateAlias.useMutation();
  const update = api.adminUpdateAlias.useMutation();
  const remove = api.adminDeleteAlias.useMutation();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<typeof aliases[number] | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || remove.isPending;
  const upstream = models.find((model) => model.id === form.upstreamModelId);
  const capabilities = upstream ? getAliasCapabilities(upstream) : null;
  const validation = upstream ? validateAliasSettings(upstream, form) : "Choose an upstream model.";
  const refresh = () => Promise.all(["adminListAliases", "adminListApps", "getModels"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const save = async () => {
    setError(null);
    try {
      const body = { ...form, modelId: form.modelId.trim(), name: form.name.trim(), description: form.description.trim() || null };
      if (editing === "new") await create.mutateAsync({ body });
      else await update.mutateAsync({ params: { id: editing! }, body });
      setEditing(null); await refresh();
    } catch (reason) { setError(apiErrorMessage(reason, "Could not save alias")); }
  };
  const deleteAlias = async () => {
    if (!deleting) return;
    setError(null);
    try { await remove.mutateAsync({ params: { id: deleting.id } }); setDeleting(null); await refresh(); }
    catch (reason) { setError(apiErrorMessage(reason, "Could not delete alias")); }
  };
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Model aliases</h1><p className="text-sm text-muted-foreground">Stable public model IDs with pinned thinking and effort. Pricing is inherited from the upstream model.</p></div><Button disabled={modelsQuery.isPending || modelsQuery.isError} onClick={() => { setForm(blank); setEditing("new"); setError(null); }}>Add alias</Button></div>
    {error && !editing && !deleting && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {aliasesQuery.isPending ? <p>Loading aliases…</p> : aliasesQuery.isError ? <p role="alert">Could not load aliases. <Button variant="outline" onClick={() => void aliasesQuery.refetch()}>Retry</Button></p> : !aliases.length ? <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">No aliases yet. Add an alias to pin a model’s reasoning settings.</div> : <div className="grid gap-3">{aliases.map((alias) => <article key={alias.id} className="space-y-3 rounded-lg border bg-card p-4"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{alias.name}</h2><Badge variant={alias.enabled ? "default" : "secondary"}>{alias.enabled ? "Enabled" : "Disabled"}</Badge><div className="ml-auto flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => { setForm({ modelId: alias.modelId, name: alias.name, description: alias.description ?? "", upstreamModelId: alias.upstreamModelId, thinking: alias.thinking, effort: alias.effort, enabled: alias.enabled }); setEditing(alias.id); setError(null); }}>Edit</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDeleting(alias); setError(null); }}>Delete</Button></div></div><code className="break-all text-sm">{alias.modelId}</code>{alias.description && <p className="text-sm text-muted-foreground">{alias.description}</p>}<p className="text-sm">{models.find((model) => model.id === alias.upstreamModelId)?.name ?? "Upstream unavailable"} · Thinking {alias.thinking ? "on" : "off"} · Effort {alias.effort ?? "provider default"}</p></article>)}</div>}
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{editing === "new" ? "Add alias" : "Edit alias"}</DialogTitle></DialogHeader>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1 text-sm">Public model ID<Input value={form.modelId} placeholder="claude-fast" onChange={(e) => setForm({ ...form, modelId: e.target.value })} /></label>
        <label className="block space-y-1 text-sm">Display name<Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="block space-y-1 text-sm">Description<Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="block space-y-1 text-sm">Upstream model<select className={selectClass} value={form.upstreamModelId} onChange={(e) => { const model = models.find((entry) => entry.id === e.target.value); const caps = model && getAliasCapabilities(model); setForm({ ...form, upstreamModelId: e.target.value, thinking: caps ? !caps.canDisableThinking : false, effort: null }); }}><option value="">Choose an upstream model</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.modelId}){model.enabled ? "" : " — disabled"}</option>)}</select></label>
        {modelsQuery.isError && <p role="alert" className="text-destructive">Could not load upstream models. <Button variant="outline" onClick={() => void modelsQuery.refetch()}>Retry</Button></p>}
        {upstream && <p className="text-xs text-muted-foreground">Inherited pricing: ${upstream.inputPricePerMTok} input / ${upstream.outputPricePerMTok} output per million tokens{!upstream.enabled && " · Upstream is disabled; this alias will not be exposed."}</p>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.thinking} disabled={!capabilities || (form.thinking ? !capabilities.canDisableThinking : !capabilities.canEnableThinking)} onChange={(e) => setForm({ ...form, thinking: e.target.checked, effort: !e.target.checked && !capabilities?.canSetEffortWithoutThinking ? null : form.effort })} />Thinking enabled (pinned)</label>
        {!form.thinking && capabilities && <p className="text-xs text-muted-foreground">{capabilities.thinkingOffDescription}</p>}
        <label className="block space-y-1 text-sm">Effort (pinned independently)<select className={selectClass} value={form.effort ?? ""} disabled={!capabilities || (!form.thinking && !capabilities.canSetEffortWithoutThinking)} onChange={(e) => setForm({ ...form, effort: (e.target.value || null) as Form["effort"] })}><option value="">{form.thinking ? "Choose an effort level" : "Provider default (no effort override)"}</option>{capabilities?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Enabled</label>
        {validation && <p className="text-sm text-muted-foreground">{validation}</p>}
      </fieldset>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy || !!validation || !form.name.trim() || !form.modelId.trim() || modelsQuery.isError} onClick={() => void save()}>{busy ? "Saving…" : "Save alias"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>Delete {deleting?.name}?</DialogTitle></DialogHeader><p className="text-sm">This removes the public alias. Apps using it must be remapped; requests to the removed ID will stop working.</p>{error && <p role="alert" className="text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void deleteAlias()}>{remove.isPending ? "Deleting…" : "Delete alias"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
