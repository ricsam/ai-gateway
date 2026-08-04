import { createFileRoute } from "@richie-router/react";
import { useEffect, useMemo, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { managementFetch, managementListAll } from "../../management-api";

type Summary = {
  days: number; since: string; creditsConsumed: number; inputTokens: number; outputTokens: number; requests: number;
  byModel: { model: string | null; creditsConsumed: number; requests: number }[];
  byUser: { userId: string; username: string; creditsConsumed: number; requests: number }[];
};
type UsageEvent = {
  id: string; time: string; username: string; source: string; type: string; model: string | null;
  creditsAdded: number; creditsConsumed: number; inputTokens: number; outputTokens: number;
};
type User = { id: string; username: string; name: string };
type Group = { id: string; name: string };

export const Route = createFileRoute("/admin/usage")({ component: Usage });

function Usage() {
  const [days, setDays] = useState("30");
  const [scope, setScope] = useState("system");
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const limit = 50;
  const scopeQuery = useMemo(() => scope.startsWith("user:") ? `&userId=${encodeURIComponent(scope.slice(5))}` : scope.startsWith("group:") ? `&groupId=${encodeURIComponent(scope.slice(6))}` : "", [scope]);

  const load = async () => {
    try {
      const [summaryResult, eventResult] = await Promise.all([
        managementFetch<{ data: Summary }>(`/usage/summary?days=${days}${scopeQuery}`),
        managementFetch<{ data: UsageEvent[]; pagination: { total: number } }>(`/usage/events?limit=${limit}&offset=${offset}${scopeQuery}`),
      ]);
      setSummary(summaryResult.data); setEvents(eventResult.data); setTotal(eventResult.pagination.total); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load usage" ); }
  };
  useEffect(() => { void Promise.all([managementListAll<User>("/users"), managementListAll<Group>("/groups")]).then(([allUsers, allGroups]) => { setUsers(allUsers); setGroups(allGroups); }).catch((reason) => setError(String(reason))); }, []);
  useEffect(() => { void load(); }, [days, offset, scopeQuery]);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">Usage</h1><p className="text-sm text-muted-foreground">System, group, user, and model metering from the billing ledger.</p></div><div className="flex flex-wrap gap-2"><Select value={scope} onValueChange={(value) => { setScope(value); setOffset(0); }}><SelectTrigger className="w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">All usage</SelectItem>{groups.map((group) => <SelectItem key={group.id} value={`group:${group.id}`}>Group: {group.name}</SelectItem>)}{users.map((user) => <SelectItem key={user.id} value={`user:${user.id}`}>User: {user.name} (@{user.username})</SelectItem>)}</SelectContent></Select><Select value={days} onValueChange={(value) => { setDays(value); setOffset(0); }}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="7">Last 7 days</SelectItem><SelectItem value="30">Last 30 days</SelectItem><SelectItem value="90">Last 90 days</SelectItem><SelectItem value="365">Last year</SelectItem></SelectContent></Select><Button variant="outline" onClick={() => void load()}><IconRefresh />Refresh</Button></div></div>
    {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Metric label="Credits consumed" value={`$${(summary?.creditsConsumed ?? 0).toFixed(6)}`} />
      <Metric label="Requests / ledger events" value={(summary?.requests ?? 0).toLocaleString()} />
      <Metric label="Input tokens" value={(summary?.inputTokens ?? 0).toLocaleString()} />
      <Metric label="Output tokens" value={(summary?.outputTokens ?? 0).toLocaleString()} />
    </div>
    <div className="grid gap-5 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Usage by model</CardTitle><CardDescription>Top models by credits consumed in the selected scope and period.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">Model</th><th className="text-right">Requests</th><th className="text-right">Credits</th></tr></thead><tbody>{summary?.byModel.map((model, index) => <tr key={`${model.model}-${index}`} className="border-b last:border-0"><td className="py-3 font-mono text-xs">{model.model ?? "Non-model adjustment"}</td><td className="text-right">{model.requests.toLocaleString()}</td><td className="text-right">${model.creditsConsumed.toFixed(6)}</td></tr>)}{!summary?.byModel.length && <tr><td colSpan={3} className="py-8 text-center text-muted-foreground">No usage in this period</td></tr>}</tbody></table></div></CardContent></Card>
      <Card><CardHeader><CardTitle>Usage by user</CardTitle><CardDescription>Users in the selected scope, ranked by credits consumed.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">User</th><th className="text-right">Requests</th><th className="text-right">Credits</th></tr></thead><tbody>{summary?.byUser.map((user) => <tr key={user.userId} className="border-b last:border-0"><td className="py-3">@{user.username}</td><td className="text-right">{user.requests.toLocaleString()}</td><td className="text-right">${user.creditsConsumed.toFixed(6)}</td></tr>)}{!summary?.byUser.length && <tr><td colSpan={3} className="py-8 text-center text-muted-foreground">No user usage in this period</td></tr>}</tbody></table></div></CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>Usage ledger</CardTitle><CardDescription>{total.toLocaleString()} events in the selected scope</CardDescription></CardHeader><CardContent className="space-y-4"><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">Time</th><th>User</th><th>Source</th><th>Type</th><th>Model</th><th className="text-right">Tokens</th><th className="text-right">Added</th><th className="text-right">Consumed</th></tr></thead><tbody>{events.map((event) => <tr key={event.id} className="border-b last:border-0"><td className="py-3">{new Date(event.time).toLocaleString()}</td><td>@{event.username}</td><td>{event.source}</td><td>{event.type}</td><td className="font-mono text-xs">{event.model ?? "—"}</td><td className="text-right">{(event.inputTokens + event.outputTokens).toLocaleString()}</td><td className="text-right">${event.creditsAdded.toFixed(6)}</td><td className="text-right">${event.creditsConsumed.toFixed(6)}</td></tr>)}</tbody></table></div><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Showing {total ? offset + 1 : 0}–{Math.min(offset + limit, total)} of {total}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button><Button variant="outline" size="sm" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>Next</Button></div></div></CardContent></Card>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl">{value}</CardTitle></CardHeader></Card>; }
