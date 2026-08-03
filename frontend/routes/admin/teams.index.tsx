import { createFileRoute, Link } from "@richie-router/react";
import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, queryClient } from "../../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/teams/")({ component: Teams });
function Teams() {
  const { data } = api.adminListTeams.useQuery({ queryKey: ["adminListTeams"], queryData: {} });
  const create = api.adminCreateTeam.useMutation(); const remove = api.adminDeleteTeam.useMutation();
  const [name, setName] = useState(""); const teams = data?.payload ?? [];
  return <div className="space-y-4"><div><h1 className="text-2xl font-semibold">Teams</h1><p className="text-sm text-muted-foreground">Teams organize members and reporting. Credits remain user-owned.</p></div><div className="flex gap-2 max-w-lg"><Input placeholder="New team name" value={name} onChange={(e) => setName(e.target.value)} /><Button onClick={async () => { await create.mutateAsync({ body: { name } }); setName(""); void queryClient.invalidateQueries({ queryKey: ["adminListTeams"] }); }} disabled={!name.trim()}><IconPlus />Create</Button></div><div className="grid md:grid-cols-2 gap-3">{teams.map((team) => <div key={team.id} className="border rounded-lg p-4 flex items-center gap-3"><Link className="flex-1" to="/admin/teams/$teamId" params={{ teamId: team.id }}><p className="font-medium">{team.name}</p><p className="text-xs text-muted-foreground">{team.memberCount} members</p></Link><Button variant="ghost" size="icon" onClick={async () => { await remove.mutateAsync({ params: { id: team.id } }); void queryClient.invalidateQueries({ queryKey: ["adminListTeams"] }); }}><IconTrash /></Button></div>)}</div></div>;
}
