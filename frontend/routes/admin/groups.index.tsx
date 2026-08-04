import { createFileRoute, Link } from "@richie-router/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertCircle,
  IconCheck,
  IconLoader2,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { managementFetch, managementListAll } from "../../management-api";

type Group = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
};

type Notice = { kind: "success" | "error"; text: string };

type BulkUpdates = {
  enabled?: boolean;
  apiEnabled?: boolean;
  defaultMonthlyCredits?: number;
};

function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="size-4 cursor-pointer rounded border-input accent-primary"
    />
  );
}

export const Route = createFileRoute("/admin/groups/")({ component: Groups });

function Groups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [quota, setQuota] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = async () => {
    try {
      setGroups(await managementListAll<Group>("/groups"));
      setNotice((current) => current?.kind === "error" ? null : current);
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Could not load groups" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? groups.filter((group) => group.name.toLowerCase().includes(query) || group.description?.toLowerCase().includes(query))
      : groups;
  }, [groups, search]);
  const visibleSelected = filtered.filter((group) => selected.has(group.id)).length;
  const allVisibleSelected = filtered.length > 0 && visibleSelected === filtered.length;

  const toggleAll = () => {
    const next = new Set(selected);
    if (allVisibleSelected) filtered.forEach((group) => next.delete(group.id));
    else filtered.forEach((group) => next.add(group.id));
    setSelected(next);
  };
  const toggleGroup = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      await managementFetch("/groups", { method: "POST", body: JSON.stringify({ name, description }) });
      setName("");
      setDescription("");
      setNotice({ kind: "success", text: "Group created" });
      await load();
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Could not create group" });
    } finally {
      setSaving(false);
    }
  };

  const applyBulk = async (updates: BulkUpdates) => {
    if (!selected.size) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await managementFetch<{ data: { usersUpdated: number } }>("/groups/bulk-user-update", {
        method: "POST",
        body: JSON.stringify({ groupIds: [...selected], ...updates }),
      });
      setNotice({ kind: "success", text: `Updated ${result.data.usersUpdated} distinct user${result.data.usersUpdated === 1 ? "" : "s"}` });
      setSelected(new Set());
      setQuota("");
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Bulk update failed" });
    } finally {
      setSaving(false);
    }
  };

  const applyQuota = () => {
    const value = Number(quota);
    if (!quota || !Number.isFinite(value) || value < 0) {
      setNotice({ kind: "error", text: "Monthly quota must be zero or greater" });
      return;
    }
    void applyBulk({ defaultMonthlyCredits: value });
  };

  const remove = async (group: Group) => {
    if (!window.confirm(`Delete group “${group.name}”? Memberships will be removed, but users are kept.`)) return;
    try {
      await managementFetch(`/groups/${group.id}`, { method: "DELETE" });
      setSelected((current) => { const next = new Set(current); next.delete(group.id); return next; });
      setNotice({ kind: "success", text: "Group deleted" });
      await load();
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Could not delete group" });
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Groups</h1>
        <p className="text-sm text-muted-foreground">
          Organize membership and apply quota or access changes to every distinct user in selected groups.
        </p>
      </div>

      {notice && (
        <div className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${notice.kind === "success" ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
          {notice.kind === "success" ? <IconCheck size={18} /> : <IconAlertCircle size={18} />}
          <span>{notice.text}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setNotice(null)}>Dismiss</Button>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Create group</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_auto]" onSubmit={create}>
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Name</Label>
              <Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-description">Description</Label>
              <Textarea id="group-description" className="min-h-9" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <Button className="self-end" disabled={!name.trim() || saving}><IconPlus />Create</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 md:grid-cols-[1fr_minmax(16rem,22rem)]">
          <div>
            <CardTitle className="text-base">Bulk user controls</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">A user in more than one selected group is updated once.</p>
          </div>
          <div className="relative">
            <IconSearch className="absolute left-3 top-2.5 text-muted-foreground" size={16} />
            <Input className="pl-9" placeholder="Filter groups" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className={`flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3 ${selected.size ? "" : "opacity-60"}`}>
            <div className="mr-auto text-sm font-medium">{selected.size} group{selected.size === 1 ? "" : "s"} selected</div>
            <div className="space-y-1">
              <Label htmlFor="bulk-quota" className="text-xs">Monthly quota ($)</Label>
              <div className="flex gap-2">
                <Input id="bulk-quota" className="w-28" type="number" min="0" step="0.01" value={quota} onChange={(event) => setQuota(event.target.value)} disabled={!selected.size || saving} />
                <Button variant="outline" onClick={applyQuota} disabled={!selected.size || !quota || saving}>Set quota</Button>
              </div>
            </div>
            <Button variant="outline" onClick={() => void applyBulk({ apiEnabled: true })} disabled={!selected.size || saving}>Enable API</Button>
            <Button variant="outline" onClick={() => void applyBulk({ apiEnabled: false })} disabled={!selected.size || saving}>Disable API</Button>
            <Button variant="outline" onClick={() => void applyBulk({ enabled: true })} disabled={!selected.size || saving}>Enable users</Button>
            <Button variant="destructive" onClick={() => void applyBulk({ enabled: false })} disabled={!selected.size || saving}>Disable users</Button>
            {saving && <IconLoader2 className="animate-spin" />}
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="w-12 p-3 text-center">
                    <SelectionCheckbox checked={allVisibleSelected} indeterminate={visibleSelected > 0 && !allVisibleSelected} onChange={toggleAll} label="Select all visible groups" />
                  </th>
                  <th className="p-3 text-left">Group</th>
                  <th className="p-3 text-left">Description</th>
                  <th className="p-3 text-right">Members</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((group) => (
                  <tr key={group.id} className="border-t hover:bg-muted/30">
                    <td className="p-3 text-center"><SelectionCheckbox checked={selected.has(group.id)} onChange={() => toggleGroup(group.id)} label={`Select ${group.name}`} /></td>
                    <td className="p-3 font-medium"><Link className="hover:underline" to="/admin/groups/$groupId" params={{ groupId: group.id }}>{group.name}</Link></td>
                    <td className="p-3 text-muted-foreground">{group.description || "—"}</td>
                    <td className="p-3 text-right">{group.memberCount}</td>
                    <td className="p-2"><Button variant="ghost" size="icon" title="Delete group" onClick={() => void remove(group)}><IconTrash /></Button></td>
                  </tr>
                ))}
                {!loading && !filtered.length && <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No groups found</td></tr>}
                {loading && <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">Loading groups…</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
