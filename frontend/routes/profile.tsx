import { createFileRoute } from "@richie-router/react";
import { useState } from "react";
import { IconCopy, IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { api, queryClient } from "../api";
import { AppShell } from "../ui/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loadPublicConfig } from "../config";

export const Route = createFileRoute("/profile")({ component: ApiAndUsage });

function ApiAndUsage() {
  const { data: profileData } = api.getProfile.useQuery({ queryKey: ["getProfile"], queryData: {} });
  const { data: keyData } = api.listApiKeys.useQuery({ queryKey: ["listApiKeys"], queryData: {} });
  const { data: usageData } = api.getUserUsageLogs.useQuery({ queryKey: ["usage"], queryData: { query: { limit: "25", offset: "0" } } });
  const createKey = api.createApiKey.useMutation();
  const deleteKey = api.deleteApiKey.useMutation();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const profile = profileData?.payload;
  const keys = keyData?.payload ?? [];
  const logs = usageData?.payload.logs ?? [];

  const create = async () => {
    const result = await createKey.mutateAsync({ body: { name, scopes: ["llm.invoke", "models.read", "credits.read"] } });
    if (result.payload) setCreated(result.payload.key);
    setName(""); void queryClient.invalidateQueries({ queryKey: ["listApiKeys"] });
  };
  const revoke = async (id: string) => { await deleteKey.mutateAsync({ params: { id } }); void queryClient.invalidateQueries({ queryKey: ["listApiKeys"] }); };

  return <AppShell><main className="max-w-6xl mx-auto p-5 md:p-8 space-y-6">
    <div><h1 className="text-2xl font-semibold">API & usage</h1><p className="text-muted-foreground text-sm">Create client credentials and review your metered model use.</p></div>
    <div className="grid sm:grid-cols-3 gap-4">
      <Card><CardHeader><CardDescription>Credit balance</CardDescription><CardTitle>${(profile?.creditBalance ?? 0).toFixed(2)}</CardTitle></CardHeader></Card>
      <Card><CardHeader><CardDescription>Monthly allocation</CardDescription><CardTitle>${(profile?.defaultMonthlyCredits ?? 0).toFixed(2)}</CardTitle></CardHeader></Card>
      <Card><CardHeader><CardDescription>Access</CardDescription><CardTitle className="flex gap-2"><Badge>{profile?.role ?? "user"}</Badge><Badge variant={profile?.apiEnabled ? "secondary" : "destructive"}>{profile?.apiEnabled ? "API enabled" : "API disabled"}</Badge></CardTitle></CardHeader></Card>
    </div>

    <Card><CardHeader><CardTitle className="flex gap-2 items-center"><IconKey /> API keys</CardTitle><CardDescription>Keys are displayed once, stored as SHA-256 hashes, and can be revoked at any time.</CardDescription></CardHeader><CardContent className="space-y-4">
      {created && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-2"><p className="text-sm font-medium">Copy this key now. It cannot be shown again.</p><div className="flex gap-2"><code className="text-xs flex-1 break-all bg-background p-3 rounded">{created}</code><Button size="icon" variant="outline" onClick={() => navigator.clipboard.writeText(created)}><IconCopy /></Button></div><Button variant="outline" size="sm" onClick={() => setCreated(null)}>Done</Button></div>}
      <div className="flex gap-2"><Input placeholder="Key name, e.g. OpenCode" value={name} onChange={(event) => setName(event.target.value)} /><Button onClick={create} disabled={!name.trim() || createKey.isPending}><IconPlus /> Create</Button></div>
      <div className="divide-y">{keys.map((key) => <div key={key.id} className="py-3 flex items-center gap-3"><div className="flex-1"><p className="font-medium">{key.name}</p><p className="text-xs text-muted-foreground"><code>{key.keyPrefix}…</code> · {key.scopes.join(", ")}{key.lastUsedAt ? ` · used ${new Date(key.lastUsedAt).toLocaleDateString()}` : ""}</p></div><Button size="icon" variant="ghost" onClick={() => revoke(key.id)}><IconTrash /></Button></div>)}</div>
      <ClientExample />
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Recent usage</CardTitle><CardDescription>{usageData?.payload.total ?? 0} ledger events</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-muted-foreground border-b"><th className="py-2">Time</th><th>Source</th><th>Model</th><th className="text-right">Tokens</th><th className="text-right">Credits</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id} className="border-b last:border-0"><td className="py-3">{new Date(log.time).toLocaleString()}</td><td>{log.source}</td><td className="font-mono text-xs">{log.model ?? "—"}</td><td className="text-right">{(log.inputTokens + log.outputTokens).toLocaleString()}</td><td className="text-right">${log.creditsConsumed.toFixed(6)}</td></tr>)}</tbody></table></div></CardContent></Card>
  </main></AppShell>;
}

function ClientExample() {
  const [baseUrl, setBaseUrl] = useState("/v1");
  useState(() => { void loadPublicConfig().then((config) => setBaseUrl(config.api.baseUrl)); });
  return <div className="rounded-lg bg-muted p-4 space-y-2"><Label>OpenAI-compatible base URL</Label><code className="block text-xs break-all">{baseUrl}</code><pre className="text-xs overflow-x-auto">{`OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=llmp_...`}</pre></div>;
}
