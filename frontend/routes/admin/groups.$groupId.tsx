import { createFileRoute, Link } from "@richie-router/react";
import { useEffect, useState } from "react";
import { IconArrowLeft, IconCheck, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { managementFetch, managementListAll } from "../../management-api";

type Member = {
  userId: string;
  username: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  source: string;
  enabled: boolean;
  apiEnabled: boolean;
  creditBalance: number;
  defaultMonthlyCredits: number;
  joinedAt: string;
};
type Group = { id: string; name: string; description: string | null; members: Member[] };
type User = { id: string; username: string; name: string; email: string };

export const Route = createFileRoute("/admin/groups/$groupId")({ component: GroupPage });

function GroupPage() {
  const { groupId } = Route.useParams();
  const [group, setGroup] = useState<Group | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState("");
  const [newRole, setNewRole] = useState<"owner" | "admin" | "member">("member");
  const [editing, setEditing] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    try {
      const [groupResult, allUsers] = await Promise.all([
        managementFetch<{ data: Group }>(`/groups/${groupId}`),
        managementListAll<User>("/users"),
      ]);
      setGroup(groupResult.data);
      setUsers(allUsers);
      setGroupForm({ name: groupResult.data.name, description: groupResult.data.description ?? "" });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load group");
    }
  };

  useEffect(() => { void load(); }, [groupId]);

  const run = async (action: () => Promise<void>, success: string) => {
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Update failed");
    }
  };

  if (!group && !error) return <p>Loading group…</p>;
  if (!group) return <p className="text-destructive">{error}</p>;
  const availableUsers = users.filter((user) => !group.members.some((member) => member.userId === user.id));

  return (
    <div className="space-y-5">
      <Link to="/admin/groups" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><IconArrowLeft size={16} />Back to groups</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        {!editing ? (
          <div><h1 className="text-2xl font-semibold">{group.name}</h1><p className="text-muted-foreground">{group.description || "No description"}</p></div>
        ) : (
          <div className="grid min-w-[min(100%,34rem)] gap-3">
            <div><Label htmlFor="group-edit-name">Name</Label><Input id="group-edit-name" value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} /></div>
            <div><Label htmlFor="group-edit-description">Description</Label><Textarea id="group-edit-description" value={groupForm.description} onChange={(event) => setGroupForm({ ...groupForm, description: event.target.value })} /></div>
          </div>
        )}
        <div className="flex gap-2">
          {editing ? <><Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button><Button disabled={!groupForm.name.trim()} onClick={() => void run(async () => {
            await managementFetch(`/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(groupForm) });
            setEditing(false);
          }, "Group details saved")}><IconCheck />Save</Button></> : <Button variant="outline" onClick={() => setEditing(true)}><IconPencil />Edit group</Button>}
        </div>
      </div>

      {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {message && <p className="rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">{message}</p>}

      <Card>
        <CardHeader><CardTitle className="text-base">Add member</CardTitle></CardHeader>
        <CardContent className="flex max-w-3xl flex-wrap gap-2">
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="min-w-64 flex-1"><SelectValue placeholder="Select a user" /></SelectTrigger>
            <SelectContent>{availableUsers.map((user) => <SelectItem key={user.id} value={user.id}>{user.name} (@{user.username}) · {user.email}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={newRole} onValueChange={(role) => setNewRole(role as typeof newRole)}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="owner">Owner</SelectItem><SelectItem value="admin">Admin</SelectItem><SelectItem value="member">Member</SelectItem></SelectContent>
          </Select>
          <Button disabled={!userId} onClick={() => void run(async () => {
            await managementFetch(`/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId, role: newRole }) });
            setUserId("");
          }, "Member added")}><IconPlus />Add</Button>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[940px] text-sm">
          <thead className="bg-muted/50"><tr><th className="p-3 text-left">User</th><th className="p-3 text-left">Membership</th><th>Balance</th><th>Monthly</th><th>Enabled</th><th>API</th><th /></tr></thead>
          <tbody>
            {group.members.map((member) => (
              <tr key={member.userId} className="border-t">
                <td className="p-3"><p className="font-medium">{member.name} <span className="font-normal text-muted-foreground">@{member.username}</span></p><p className="text-xs text-muted-foreground">{member.email}</p></td>
                <td className="p-3"><div className="flex items-center gap-2"><Select value={member.role} disabled={member.source !== "manual"} onValueChange={(role) => void run(async () => {
                  await managementFetch(`/groups/${groupId}/members/${member.userId}`, { method: "PATCH", body: JSON.stringify({ role }) });
                }, "Membership role saved")}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="owner">Owner</SelectItem><SelectItem value="admin">Admin</SelectItem><SelectItem value="member">Member</SelectItem></SelectContent></Select>{member.source !== "manual" && <Badge variant="outline">{member.source}</Badge>}</div></td>
                <td className="text-center font-mono">${member.creditBalance.toFixed(2)}</td>
                <td className="text-center font-mono">${member.defaultMonthlyCredits.toFixed(2)}</td>
                <td className="text-center"><Switch checked={member.enabled} onCheckedChange={(enabled) => void run(async () => { await managementFetch(`/users/${member.userId}`, { method: "PATCH", body: JSON.stringify({ enabled }) }); }, "User access saved")} /></td>
                <td className="text-center"><Switch checked={member.apiEnabled} onCheckedChange={(apiEnabled) => void run(async () => { await managementFetch(`/users/${member.userId}`, { method: "PATCH", body: JSON.stringify({ apiEnabled }) }); }, "API access saved")} /></td>
                <td className="p-2"><Button variant="ghost" size="icon" disabled={member.source !== "manual"} title={member.source === "manual" ? "Remove member" : "Externally synchronized memberships cannot be removed here"} onClick={() => void run(async () => {
                  await managementFetch(`/groups/${groupId}/members/${member.userId}`, { method: "DELETE" });
                }, "Member removed")}><IconTrash /></Button></td>
              </tr>
            ))}
            {!group.members.length && <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">No members</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
