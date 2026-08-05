import { createFileRoute, Link } from "@richie-router/react";
import { useEffect, useMemo, useState } from "react";
import { IconKey, IconPencil, IconPlus, IconRefresh, IconTrash, IconUsersGroup } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { managementFetch, managementListAll } from "../../management-api";

type Group = { id: string; name: string; role?: string };
type User = {
  id: string;
  username: string;
  name: string;
  email: string;
  role: "user" | "admin";
  enabled: boolean;
  apiEnabled: boolean;
  mustChangePassword: boolean;
  creditBalance: number;
  defaultMonthlyCredits: number;
  createdAt: string;
  groups: Group[];
};
type UserForm = {
  username: string;
  email: string;
  name: string;
  password: string;
  role: "user" | "admin";
  enabled: boolean;
  apiEnabled: boolean;
  mustChangePassword: boolean;
  creditBalance: string;
  defaultMonthlyCredits: string;
  groupIds: string[];
};

const blankUser: UserForm = {
  username: "", email: "", name: "", password: "", role: "user", enabled: true, apiEnabled: true,
  mustChangePassword: true, creditBalance: "0", defaultMonthlyCredits: "0", groupIds: [],
};

export const Route = createFileRoute("/admin/users/")({ component: Users });

function GroupChoices({ groups, selected, onChange }: { groups: Group[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="grid max-h-40 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
      {groups.map((group) => (
        <label key={group.id} className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={selected.includes(group.id)} onChange={(event) => onChange(event.target.checked ? [...selected, group.id] : selected.filter((id) => id !== group.id))} />
          {group.name}
        </label>
      ))}
      {!groups.length && <p className="text-sm text-muted-foreground">Create a group first to assign membership.</p>}
    </div>
  );
}

function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<UserForm>(blankUser);
  const [editing, setEditing] = useState<User | null>(null);
  const [editForm, setEditForm] = useState<UserForm>(blankUser);
  const [passwordUser, setPasswordUser] = useState<User | null>(null);
  const [password, setPassword] = useState("");
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(true);
  const [creditDrafts, setCreditDrafts] = useState<Record<string, { balance: string; monthly: string }>>({});
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [allUsers, allGroups] = await Promise.all([managementListAll<User>("/users"), managementListAll<Group>("/groups")]);
      setUsers(allUsers);
      setGroups(allGroups);
      setCreditDrafts((current) => Object.fromEntries(allUsers.map((user) => [user.id, current[user.id] ?? { balance: String(user.creditBalance), monthly: String(user.defaultMonthlyCredits) }])));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load users");
    }
  };
  useEffect(() => { void load(); }, []);

  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? users.filter((user) => [user.username, user.name, user.email, ...user.groups.map((group) => group.name)].some((value) => value.toLowerCase().includes(query))) : users;
  }, [users, search]);

  const run = async (action: () => Promise<void>, success: string) => {
    setSaving(true); setError(null); setMessage(null);
    try { await action(); setMessage(success); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Update failed"); }
    finally { setSaving(false); }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await managementFetch("/users", { method: "POST", body: JSON.stringify({
        ...form,
        creditBalance: Number(form.creditBalance),
        defaultMonthlyCredits: Number(form.defaultMonthlyCredits),
      }) });
      setForm(blankUser); setShowCreate(false);
    }, "User created");
  };

  const openEdit = (user: User) => {
    setEditing(user);
    setEditForm({
      username: user.username, email: user.email, name: user.name, password: "", role: user.role,
      enabled: user.enabled, apiEnabled: user.apiEnabled, mustChangePassword: user.mustChangePassword,
      creditBalance: String(user.creditBalance), defaultMonthlyCredits: String(user.defaultMonthlyCredits), groupIds: user.groups.map((group) => group.id),
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    await run(async () => {
      await managementFetch(`/users/${editing.id}`, { method: "PATCH", body: JSON.stringify({
        username: editForm.username, email: editForm.email, name: editForm.name, role: editForm.role,
        enabled: editForm.enabled, apiEnabled: editForm.apiEnabled, mustChangePassword: editForm.mustChangePassword,
      }) });
      await managementFetch(`/users/${editing.id}/groups`, { method: "PUT", body: JSON.stringify({ groupIds: editForm.groupIds }) });
      setEditing(null);
    }, "User details saved");
  };

  const saveCredits = async (user: User) => {
    const draft = creditDrafts[user.id] ?? { balance: String(user.creditBalance), monthly: String(user.defaultMonthlyCredits) };
    const balance = Number(draft.balance); const monthly = Number(draft.monthly);
    if (!Number.isFinite(balance) || !Number.isFinite(monthly) || balance < 0 || monthly < 0) { setError("Credits must be valid numbers zero or greater"); return; }
    await run(async () => {
      await managementFetch(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ creditBalance: balance, defaultMonthlyCredits: monthly }) });
      setCreditDrafts((current) => ({ ...current, [user.id]: { balance: String(balance), monthly: String(monthly) } }));
    }, `Credits saved for @${user.username}`);
  };

  const changeAccess = (user: User, updates: Partial<Pick<User, "enabled" | "apiEnabled" | "role">>) => run(async () => {
    await managementFetch(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify(updates) });
  }, `Access saved for @${user.username}`);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-4">
        <div><h1 className="text-2xl font-semibold">Users</h1><p className="text-sm text-muted-foreground">Create local accounts and manage identity, access, credits, passwords, and groups.</p></div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={saving} onClick={() => {
            if (!window.confirm("Reset every user with a monthly quota to that balance now?")) return;
            void run(async () => {
              const result = await managementFetch<{ data: { usersReset: number } }>("/users/monthly-reset", { method: "POST" });
              setMessage(`Monthly credits reset for ${result.data.usersReset} users`);
            }, "Monthly credit reset completed");
          }}><IconRefresh />Run monthly reset</Button>
          <Button onClick={() => setShowCreate((value) => !value)}><IconPlus />New user</Button>
        </div>
      </div>

      {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {message && <p className="rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">{message}</p>}

      {showCreate && (
        <Card>
          <CardHeader><CardTitle>Create local user</CardTitle><CardDescription>The password is set by the administrator and never returned by the API.</CardDescription></CardHeader>
          <CardContent><form className="space-y-4" onSubmit={create}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(["username", "email", "name", "password"] as const).map((field) => <div className="space-y-1.5" key={field}><Label className="capitalize" htmlFor={`create-${field}`}>{field}</Label><Input id={`create-${field}`} type={field === "password" ? "password" : field === "email" ? "email" : "text"} autoComplete={field === "password" ? "new-password" : undefined} value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} required /></div>)}
              <div className="space-y-1.5"><Label>Initial balance ($)</Label><Input type="number" min="0" step="0.01" value={form.creditBalance} onChange={(event) => setForm({ ...form, creditBalance: event.target.value })} /></div>
              <div className="space-y-1.5"><Label>Monthly quota ($)</Label><Input type="number" min="0" step="0.01" value={form.defaultMonthlyCredits} onChange={(event) => setForm({ ...form, defaultMonthlyCredits: event.target.value })} /></div>
              <Toggle label="Administrator" checked={form.role === "admin"} onChange={(value) => setForm({ ...form, role: value ? "admin" : "user" })} />
              <Toggle label="Force password change" checked={form.mustChangePassword} onChange={(value) => setForm({ ...form, mustChangePassword: value })} />
              <Toggle label="Account enabled" checked={form.enabled} onChange={(value) => setForm({ ...form, enabled: value })} />
              <Toggle label="API enabled" checked={form.apiEnabled} onChange={(value) => setForm({ ...form, apiEnabled: value })} />
            </div>
            <div className="space-y-1.5"><Label>Groups</Label><GroupChoices groups={groups} selected={form.groupIds} onChange={(groupIds) => setForm({ ...form, groupIds })} /></div>
            <Button disabled={saving}>Create user</Button>
          </form></CardContent>
        </Card>
      )}

      <Input className="max-w-md" placeholder="Filter by user, email, or group" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1180px] text-sm">
          <thead className="bg-muted/50"><tr><th className="p-3 text-left">User</th><th>Role</th><th>Groups</th><th>Balance</th><th>Monthly quota</th><th>Enabled</th><th>API</th><th className="text-right">Actions</th></tr></thead>
          <tbody>
            {filteredUsers.map((user) => {
              const draft = creditDrafts[user.id] ?? { balance: String(user.creditBalance), monthly: String(user.defaultMonthlyCredits) };
              const creditsChanged = Number(draft.balance) !== user.creditBalance || Number(draft.monthly) !== user.defaultMonthlyCredits;
              return <tr key={user.id} className="border-t align-top">
                <td className="p-3"><Link to="/admin/users/$userId" params={{ userId: user.id }} className="font-medium hover:underline">{user.name} <span className="font-normal text-muted-foreground">@{user.username}</span></Link><p className="text-xs text-muted-foreground">{user.email}</p>{user.mustChangePassword && <Badge variant="outline" className="mt-1">Password change required</Badge>}</td>
                <td className="p-3 text-center"><Button variant="outline" size="sm" disabled={saving} onClick={() => void changeAccess(user, { role: user.role === "admin" ? "user" : "admin" })}>{user.role}</Button></td>
                <td className="p-3"><div className="flex max-w-64 flex-wrap justify-center gap-1">{user.groups.map((group) => <Badge variant="outline" key={group.id}>{group.name}</Badge>)}{!user.groups.length && <span className="text-xs text-muted-foreground">None</span>}</div></td>
                <td className="p-3"><Input className="w-28" type="number" min="0" step="0.01" value={draft.balance} onChange={(event) => setCreditDrafts({ ...creditDrafts, [user.id]: { ...draft, balance: event.target.value } })} /></td>
                <td className="p-3"><div className="flex items-center gap-1"><Input className="w-28" type="number" min="0" step="0.01" value={draft.monthly} onChange={(event) => setCreditDrafts({ ...creditDrafts, [user.id]: { ...draft, monthly: event.target.value } })} />{creditsChanged && <Button size="sm" onClick={() => void saveCredits(user)} disabled={saving}>Save</Button>}</div></td>
                <td className="p-3 text-center"><Switch checked={user.enabled} disabled={saving} onCheckedChange={(enabled) => void changeAccess(user, { enabled })} /></td>
                <td className="p-3 text-center"><Switch checked={user.apiEnabled} disabled={saving} onCheckedChange={(apiEnabled) => void changeAccess(user, { apiEnabled })} /></td>
                <td className="p-3"><div className="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" title="Edit identity and groups" onClick={() => openEdit(user)}><IconPencil /></Button>
                  <Button variant="ghost" size="icon" title="Set password" onClick={() => { setPasswordUser(user); setPassword(""); setPasswordChangeRequired(true); }}><IconKey /></Button>
                  <Button variant="ghost" size="icon" title="Delete user" onClick={() => {
                    if (!window.confirm(`Permanently delete @${user.username}? This also removes sessions, memberships, and API keys.`)) return;
                    void run(async () => { await managementFetch(`/users/${user.id}`, { method: "DELETE" }); }, "User deleted");
                  }}><IconTrash /></Button>
                </div></td>
              </tr>;
            })}
            {!filteredUsers.length && <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No users found</td></tr>}
          </tbody>
        </table>
      </div>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Edit @{editing?.username}</DialogTitle></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Username</Label><Input value={editForm.username} onChange={(event) => setEditForm({ ...editForm, username: event.target.value })} /></div>
            <div><Label>Email</Label><Input type="email" value={editForm.email} onChange={(event) => setEditForm({ ...editForm, email: event.target.value })} /></div>
            <div className="sm:col-span-2"><Label>Display name</Label><Input value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></div>
            <Toggle label="Administrator" checked={editForm.role === "admin"} onChange={(value) => setEditForm({ ...editForm, role: value ? "admin" : "user" })} />
            <Toggle label="Account enabled" checked={editForm.enabled} onChange={(enabled) => setEditForm({ ...editForm, enabled })} />
            <Toggle label="API enabled" checked={editForm.apiEnabled} onChange={(apiEnabled) => setEditForm({ ...editForm, apiEnabled })} />
            <Toggle label="Require password change" checked={editForm.mustChangePassword} onChange={(mustChangePassword) => setEditForm({ ...editForm, mustChangePassword })} />
            <div className="space-y-1.5 sm:col-span-2"><Label className="flex items-center gap-2"><IconUsersGroup />Manual groups</Label><GroupChoices groups={groups} selected={editForm.groupIds} onChange={(groupIds) => setEditForm({ ...editForm, groupIds })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={saving || !editForm.username.trim() || !editForm.email.trim() || !editForm.name.trim()} onClick={() => void saveEdit()}>Save user</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!passwordUser} onOpenChange={(open) => !open && setPasswordUser(null)}>
        <DialogContent><DialogHeader><DialogTitle>Set password for @{passwordUser?.username}</DialogTitle></DialogHeader>
          <div className="space-y-3"><div><Label>New password</Label><Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div><Toggle label="Require change on next login" checked={passwordChangeRequired} onChange={setPasswordChangeRequired} /></div>
          <DialogFooter><Button variant="outline" onClick={() => setPasswordUser(null)}>Cancel</Button><Button disabled={saving || password.length < 12} onClick={() => void run(async () => {
            await managementFetch(`/users/${passwordUser!.id}/password`, { method: "POST", body: JSON.stringify({ password, mustChangePassword: passwordChangeRequired }) });
            setPasswordUser(null);
          }, "Password replaced and active sessions invalidated")}>Set password</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-center gap-2 self-end rounded-md border px-3 py-2 text-sm"><Switch checked={checked} onCheckedChange={onChange} /><span>{label}</span></label>;
}
