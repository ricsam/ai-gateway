import { createFileRoute } from "@richie-router/react";
import { useEffect, useMemo, useState } from "react";
import { IconCopy, IconRefresh } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { managementFetch } from "../../management-api";

type Key = { id: string; name: string; keyPrefix: string; scopes: string[]; revokedAt: string | null; expiresAt: string | null; lastUsedAt: string | null; createdAt: string };
type Event = { id: string; action: string; actorType: string; actorId: string | null; targetType: string; targetId: string | null; requestId: string; metadata: Record<string, unknown>; createdAt: string };
const scopeGroups = [
  ["Users", ["users.read", "users.write"]], ["Groups", ["groups.read", "groups.write"]], ["Authentication", ["auth.read", "auth.write"]],
  ["Branding", ["branding.read", "branding.write"]], ["AWS", ["aws.read", "aws.write"]], ["Models", ["models.read", "models.write"]],
  ["Settings & usage", ["settings.read", "settings.write", "usage.read"]], ["Management keys", ["management-keys.read", "management-keys.write"]], ["Audit", ["audit.read"]],
] as const;

export const Route = createFileRoute("/admin/security")({ component: Security });

function Security() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["users.read", "groups.read", "audit.read"]);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limit = 50;

  const load = async () => {
    try {
      const [keyResult, auditResult] = await Promise.all([
        managementFetch<{ data: Key[] }>("/management-keys"),
        managementFetch<{ data: Event[]; pagination: { total: number } }>(`/audit-events?limit=${limit}&offset=${auditOffset}`),
      ]);
      setKeys(keyResult.data); setEvents(auditResult.data); setAuditTotal(auditResult.pagination.total); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load security data"); }
  };
  useEffect(() => { void load(); }, [auditOffset]);
  const allScopes = useMemo(() => scopeGroups.flatMap(([, scopes]) => [...scopes]), []);

  const create = async () => {
    try {
      const result = await managementFetch<{ data: Key & { key: string } }>("/management-keys", { method: "POST", body: JSON.stringify({ name, scopes: selectedScopes, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined }) });
      setCreatedKey(result.data.key); setName(""); setExpiresAt(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create management key"); }
  };

  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">Keys & audit</h1><p className="text-sm text-muted-foreground">Scoped automation credentials and append-only administrative history.</p></div>
    {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <div className="grid gap-5 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Management keys</CardTitle><CardDescription>Dedicated automation credentials never authorize inference.</CardDescription></CardHeader><CardContent className="space-y-5">
        {createdKey && <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3"><p className="mb-2 text-sm font-medium">Copy this key now. It will not be shown again.</p><div className="flex gap-2"><code className="flex-1 break-all rounded bg-background p-2 text-xs">{createdKey}</code><Button variant="outline" size="icon" onClick={() => void navigator.clipboard.writeText(createdKey)}><IconCopy /></Button></div><Button variant="ghost" size="sm" className="mt-2" onClick={() => setCreatedKey(null)}>Done</Button></div>}
        <div className="grid gap-3 sm:grid-cols-2"><div><Label>Key name</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div><div><Label>Expires at (optional)</Label><Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></div></div>
        <div className="space-y-2"><div className="flex items-center justify-between"><Label>Scopes</Label><div className="flex gap-1"><Button variant="ghost" size="xs" onClick={() => setSelectedScopes(allScopes)}>Select all</Button><Button variant="ghost" size="xs" onClick={() => setSelectedScopes([])}>Clear</Button></div></div><div className="grid max-h-64 gap-3 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">{scopeGroups.map(([label, scopes]) => <div key={label}><p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>{scopes.map((scope) => <label key={scope} className="flex items-center gap-2 py-1 text-xs"><input type="checkbox" className="size-4 accent-primary" checked={selectedScopes.includes(scope)} onChange={(event) => setSelectedScopes(event.target.checked ? [...selectedScopes, scope] : selectedScopes.filter((item) => item !== scope))} /><code>{scope}</code></label>)}</div>)}</div></div>
        <Button disabled={!name.trim() || !selectedScopes.length} onClick={() => void create()}>Create management key</Button>
        <div className="divide-y rounded-md border">{keys.map((key) => <div className="space-y-2 p-3" key={key.id}><div className="flex items-center gap-2"><div className="flex-1"><p className="font-medium text-sm">{key.name}</p><p className="text-xs text-muted-foreground"><code>{key.keyPrefix}…</code> · Created {new Date(key.createdAt).toLocaleDateString()}{key.lastUsedAt ? ` · Used ${new Date(key.lastUsedAt).toLocaleString()}` : ""}</p></div>{key.revokedAt ? <Badge variant="secondary">Revoked</Badge> : <Button variant="outline" size="sm" onClick={async () => { await managementFetch(`/management-keys/${key.id}`, { method: "DELETE" }); await load(); }}>Revoke</Button>}</div><div className="flex flex-wrap gap-1">{key.scopes.map((scope) => <Badge key={scope} variant="outline"><code>{scope}</code></Badge>)}</div></div>)}{!keys.length && <p className="p-4 text-sm text-muted-foreground">No management keys.</p>}</div>
      </CardContent></Card>
      <Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>Audit history</CardTitle><CardDescription>{auditTotal.toLocaleString()} redacted administrative events.</CardDescription></div><Button variant="ghost" size="icon" onClick={() => void load()}><IconRefresh /></Button></div></CardHeader><CardContent className="space-y-3"><div className="divide-y">{events.map((event) => <div className="space-y-1 py-3" key={event.id}><p className="text-sm font-medium">{event.action}</p><p className="text-xs text-muted-foreground">{event.actorType}{event.actorId ? ` ${event.actorId}` : ""} · {event.targetType}{event.targetId ? ` ${event.targetId}` : ""} · {new Date(event.createdAt).toLocaleString()}</p><p className="break-all font-mono text-[11px] text-muted-foreground">request {event.requestId}{Object.keys(event.metadata ?? {}).length ? ` · ${JSON.stringify(event.metadata)}` : ""}</p></div>)}</div><div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{auditTotal ? auditOffset + 1 : 0}–{Math.min(auditOffset + limit, auditTotal)} of {auditTotal}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!auditOffset} onClick={() => setAuditOffset(Math.max(0, auditOffset - limit))}>Previous</Button><Button variant="outline" size="sm" disabled={auditOffset + limit >= auditTotal} onClick={() => setAuditOffset(auditOffset + limit)}>Next</Button></div></div></CardContent></Card>
    </div>
  </div>;
}
