import { createFileRoute } from "@richie-router/react";
import { useState } from "react";
import { apiErrorMessage } from "../../lib/api-error";
import { api, queryClient } from "../../api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/apps")({ component: Apps });
type Tier = { name: string; aliasId: string | null };
type Form = { name: string; description: string; enabled: boolean; tiers: Tier[] };
const blank = (): Form => ({ name: "", description: "", enabled: true, tiers: ["min", "low", "medium", "high", "max"].map((name) => ({ name, aliasId: null })) });
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function CopyableId({ value }: { value: string }) {
  const [status, setStatus] = useState("");
  return <span className="inline-flex flex-wrap items-center gap-2"><button type="button" className="rounded bg-muted px-2 py-1 text-left font-mono text-xs break-all hover:bg-muted/70" aria-label={`Copy model ID ${value}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setStatus("Copied"); } catch { setStatus("Copy unavailable; select the ID manually"); } }}>{value}</button><span role="status" className="text-xs text-muted-foreground">{status}</span></span>;
}
function Apps() {
  const appsQuery = api.adminListApps.useQuery({ queryKey: ["adminListApps"], queryData: {} });
  const aliasesQuery = api.adminListAliases.useQuery({ queryKey: ["adminListAliases"], queryData: {} });
  const apps = appsQuery.data?.payload ?? [];
  const aliases = aliasesQuery.data?.payload ?? [];
  const create = api.adminCreateApp.useMutation();
  const update = api.adminUpdateApp.useMutation();
  const remove = api.adminDeleteApp.useMutation();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<typeof apps[number] | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const busy = create.isPending || update.isPending || remove.isPending;
  const validation = !slug.test(form.name) ? "Use a lowercase kebab-case app name (for example, my-app)." : !form.tiers.length ? "Add at least one tier." : form.tiers.some((tier) => !slug.test(tier.name)) ? "Tier names must be lowercase kebab-case." : new Set(form.tiers.map((tier) => tier.name)).size !== form.tiers.length ? "Tier names must be unique." : null;
  const refresh = () => Promise.all(["adminListApps", "getModels"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const save = async () => {
    setError(null);
    try {
      const body = { ...form, description: form.description.trim() || null };
      if (editing === "new") await create.mutateAsync({ body }); else await update.mutateAsync({ params: { id: editing! }, body });
      setEditing(null); await refresh();
    } catch (reason) { setError(apiErrorMessage(reason, "Could not save app")); }
  };
  const deleteApp = async () => {
    if (!deleting) return;
    setError(null);
    try { await remove.mutateAsync({ params: { id: deleting.id } }); setDeleting(null); await refresh(); }
    catch (reason) { setError(apiErrorMessage(reason, "Could not delete app")); }
  };
  const changeTier = (index: number, patch: Partial<Tier>) => setForm({ ...form, tiers: form.tiers.map((tier, i) => i === index ? { ...tier, ...patch } : tier) });
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Apps</h1><p className="text-sm text-muted-foreground">Give each application stable model IDs, then map its tiers to model aliases.</p></div><Button onClick={() => { setForm(blank()); setEditing("new"); setError(null); }}>Add app</Button></div>
    {error && !editing && !deleting && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {aliasesQuery.isError && <p role="alert" className="text-sm text-destructive">Could not load alias mappings. <Button variant="outline" onClick={() => void aliasesQuery.refetch()}>Retry</Button></p>}
    {appsQuery.isPending ? <p>Loading apps…</p> : appsQuery.isError ? <p role="alert">Could not load apps. <Button variant="outline" onClick={() => void appsQuery.refetch()}>Retry</Button></p> : !apps.length ? <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">No apps yet. Create an app with min, low, medium, high and max tiers, or define your own.</div> : <>
      <div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => setExpanded(new Set(apps.map((app) => app.id)))}>Expand all</Button><Button variant="ghost" size="sm" onClick={() => setExpanded(new Set())}>Collapse all</Button></div>
      {apps.map((app) => <article key={app.id} className="overflow-hidden rounded-xl border bg-card"><div className="flex flex-wrap items-center gap-2 p-4"><button className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={expanded.has(app.id)} aria-controls={`app-${app.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(app.id)) next.delete(app.id); else next.add(app.id); return next; })}><span aria-hidden="true">{expanded.has(app.id) ? "▾" : "▸"}</span><span><span className="block font-semibold">{app.name}</span><span className="text-xs text-muted-foreground">{app.tiers.filter((tier) => tier.aliasId).length} of {app.tiers.length} tiers mapped</span></span></button><Badge variant={app.enabled ? "default" : "secondary"}>{app.enabled ? "Enabled" : "Disabled"}</Badge><Button variant="outline" size="sm" disabled={busy} onClick={() => { setForm({ name: app.name, description: app.description ?? "", enabled: app.enabled, tiers: app.tiers.map(({ name, aliasId }) => ({ name, aliasId })) }); setEditing(app.id); setError(null); }}>Edit</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDeleting(app); setError(null); }}>Delete</Button></div>
        {app.description && <p className="px-4 pb-4 text-sm text-muted-foreground">{app.description}</p>}
        {expanded.has(app.id) && <div id={`app-${app.id}`} className="space-y-2 border-t p-4">{app.tiers.map((tier) => { const alias = aliases.find((entry) => entry.id === tier.aliasId); return <div key={tier.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"><div><div className="mb-1 text-sm font-medium">{tier.name}</div><CopyableId value={tier.modelId} /></div><div className="text-sm text-muted-foreground">{alias ? <><span className="font-medium text-foreground">{alias.name}</span><span className="block font-mono text-xs">{alias.modelId}</span><span className="text-xs">Thinking {alias.thinking ? "on" : "off"} · {alias.effort ?? "provider default"} effort{!alias.enabled && " · Alias disabled"}{!app.enabled && " · App disabled"}</span></> : tier.aliasId ? "Alias unavailable" : "Unmapped — not exposed"}</div></div>; })}</div>}
      </article>)}
    </>}
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editing === "new" ? "Add app" : "Edit app"}</DialogTitle></DialogHeader>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1 text-sm">App name<Input value={form.name} placeholder="my-app" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <p className="text-xs text-muted-foreground">Model IDs use app-tier, for example my-app-high. Renaming an app or tier changes its public model ID.</p>
        <label className="block space-y-1 text-sm">Description<Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Enabled</label>
        <div className="space-y-3"><h3 className="font-medium">Tiers & alias mappings</h3><p className="text-xs text-muted-foreground">Unmapped tiers are saved but not exposed to API clients. Mapped tiers inherit their alias’s reasoning settings and upstream pricing.</p>
          {aliasesQuery.isPending && <p className="text-sm">Loading aliases…</p>}
          {aliasesQuery.isError && <p role="alert" className="text-sm text-destructive">Aliases could not be loaded. Close this dialog and retry.</p>}
          {!aliasesQuery.isPending && !aliasesQuery.isError && !aliases.length && <p className="text-sm text-muted-foreground">Create aliases on the Model aliases page to map these tiers. You can save unmapped tiers now.</p>}
          {form.tiers.map((tier, index) => <div key={index} className="space-y-2 rounded-lg border p-3"><div className="flex gap-2"><Input aria-label={`Tier ${index + 1} name`} value={tier.name} placeholder="custom-tier" onChange={(e) => changeTier(index, { name: e.target.value })} /><Button variant="ghost" onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, i) => i !== index) })} aria-label={`Remove tier ${tier.name || index + 1}`}>Remove</Button></div><select aria-label={`Alias for tier ${tier.name || index + 1}`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={tier.aliasId ?? ""} disabled={aliasesQuery.isPending || aliasesQuery.isError} onChange={(e) => changeTier(index, { aliasId: e.target.value || null })}><option value="">Unmapped — not exposed</option>{tier.aliasId && !aliases.some((alias) => alias.id === tier.aliasId) && <option value={tier.aliasId}>Current alias unavailable</option>}{aliases.map((alias) => <option key={alias.id} value={alias.id}>{alias.name} ({alias.modelId}){alias.enabled ? "" : " — disabled"}</option>)}</select><p className="break-all text-xs text-muted-foreground"><code>{form.name || "app"}-{tier.name || "tier"}</code> → {aliases.find((alias) => alias.id === tier.aliasId)?.modelId ?? (tier.aliasId ? "Alias unavailable" : "not exposed")}</p></div>)}
          <Button variant="outline" onClick={() => setForm({ ...form, tiers: [...form.tiers, { name: "", aliasId: null }] })}>Add custom tier</Button>
        </div>{validation && <p className="text-sm text-muted-foreground">{validation}</p>}
      </fieldset>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy || !!validation || aliasesQuery.isPending || aliasesQuery.isError} onClick={() => void save()}>{busy ? "Saving…" : "Save app"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>Delete {deleting?.name}?</DialogTitle></DialogHeader><p className="text-sm">All model IDs for this app will stop working. The mapped aliases will not be deleted.</p>{error && <p role="alert" className="text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void deleteApp()}>{remove.isPending ? "Deleting…" : "Delete app"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
