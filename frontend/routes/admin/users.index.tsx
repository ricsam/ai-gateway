import { createFileRoute } from "@richie-router/react";
import { useState } from "react";
import { api, queryClient } from "../../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/admin/users/")({ component: Users });

function Users() {
  const { data } = api.adminListUsers.useQuery({ queryKey: ["adminListUsers"], queryData: {} });
  const update = api.adminUpdateUser.useMutation();
  const updateCredits = api.adminUpdateUserCredits.useMutation();
  const reset = api.adminRunMonthlyReset.useMutation();
  const [error, setError] = useState<string | null>(null);
  const [creditDrafts, setCreditDrafts] = useState<Record<string, { balance: string; monthly: string }>>({});
  const users = data?.payload ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["adminListUsers"] });
  const change = async (id: string, body: { role?: "user" | "admin"; enabled?: boolean; apiEnabled?: boolean }) => {
    setError(null);
    try {
      const result = await update.mutateAsync({ params: { id }, body });
      if (result.status >= 400) throw new Error("Could not update user");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update user");
    }
  };
  const saveCredits = async (user: typeof users[number]) => {
    const draft = creditDrafts[user.id] ?? { balance: String(user.creditBalance), monthly: String(user.defaultMonthlyCredits) };
    setError(null);
    try {
      const result = await updateCredits.mutateAsync({
        params: { id: user.id },
        body: { creditBalance: Number(draft.balance), defaultMonthlyCredits: Number(draft.monthly) },
      });
      if (result.status >= 400) throw new Error("Could not update credits");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update credits");
    }
  };

  return <div className="space-y-4">
    <div className="flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-semibold">Users</h1><p className="text-sm text-muted-foreground">Manage OIDC users, proxy access, roles, and user-owned credits.</p></div><Button variant="outline" onClick={async () => { await reset.mutateAsync({}); await refresh(); }}>Run monthly reset</Button></div>
    {error && <p className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</p>}
    <div className="border rounded-lg overflow-x-auto"><table className="w-full min-w-[1050px] text-sm"><thead className="bg-muted/50"><tr><th className="text-left p-3">User</th><th>Role</th><th>Teams</th><th>Balance</th><th>Monthly</th><th>Enabled</th><th>API</th><th /></tr></thead><tbody>{users.map((user) => {
      const draft = creditDrafts[user.id] ?? { balance: String(user.creditBalance), monthly: String(user.defaultMonthlyCredits) };
      return <tr className="border-t" key={user.id}><td className="p-3"><p className="font-medium">{user.name}</p><p className="text-xs text-muted-foreground">{user.email}</p></td><td className="text-center"><Button size="sm" variant="outline" onClick={() => void change(user.id, { role: user.role === "admin" ? "user" : "admin" })}><Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role}</Badge></Button></td><td><div className="flex justify-center gap-1">{user.teams.map((team) => <Badge key={team.id} variant="outline">{team.name}</Badge>)}</div></td><td><Input className="w-28 mx-auto" type="number" min="0" step="0.01" value={draft.balance} onChange={(event) => setCreditDrafts((current) => ({ ...current, [user.id]: { ...draft, balance: event.target.value } }))} /></td><td><Input className="w-28 mx-auto" type="number" min="0" step="0.01" value={draft.monthly} onChange={(event) => setCreditDrafts((current) => ({ ...current, [user.id]: { ...draft, monthly: event.target.value } }))} /></td><td className="text-center"><Switch checked={user.enabled} onCheckedChange={(enabled) => void change(user.id, { enabled })} /></td><td className="text-center"><Switch checked={user.apiEnabled} onCheckedChange={(apiEnabled) => void change(user.id, { apiEnabled })} /></td><td><Button size="sm" variant="outline" onClick={() => void saveCredits(user)}>Save credits</Button></td></tr>;
    })}</tbody></table></div>
  </div>;
}
