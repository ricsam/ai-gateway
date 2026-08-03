import { createFileRoute, Link } from "@richie-router/react";
import { useState } from "react";
import { IconArrowLeft, IconPlus, IconTrash } from "@tabler/icons-react";
import { api, queryClient } from "../../api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/admin/teams/$teamId")({ component: Team });
function Team() {
  const { teamId } = Route.useParams();
  const { data } = api.adminGetTeam.useQuery({ queryKey: ["adminGetTeam", teamId], queryData: { params: { id: teamId } } });
  const { data: usersData } = api.adminListUsers.useQuery({ queryKey: ["adminListUsers"], queryData: {} });
  const add = api.adminAddTeamMember.useMutation(); const remove = api.adminRemoveTeamMember.useMutation(); const update = api.adminUpdateTeamMember.useMutation();
  const [userId, setUserId] = useState(""); const team = data?.payload; const users = usersData?.payload ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["adminGetTeam", teamId] });
  if (!team) return <p>Loading team...</p>;
  return <div className="space-y-5"><Link to="/admin/teams" className="inline-flex gap-2 text-sm text-muted-foreground"><IconArrowLeft size={16} />Back</Link><div><h1 className="text-2xl font-semibold">{team.name}</h1><p className="text-muted-foreground">{team.description}</p></div><div className="flex gap-2 max-w-xl"><Select value={userId} onValueChange={setUserId}><SelectTrigger><SelectValue placeholder="Select a user" /></SelectTrigger><SelectContent>{users.filter((user) => !team.members.some((member) => member.userId === user.id)).map((user) => <SelectItem key={user.id} value={user.id}>{user.name} ({user.email})</SelectItem>)}</SelectContent></Select><Button disabled={!userId} onClick={async () => { await add.mutateAsync({ params: { id: teamId }, body: { userId, role: "member" } }); setUserId(""); await refresh(); }}><IconPlus />Add</Button></div><div className="border rounded-lg divide-y">{team.members.map((member) => <div key={member.userId} className="p-3 flex items-center gap-3"><div className="flex-1"><p className="font-medium">{member.name}</p><p className="text-xs text-muted-foreground">{member.email}</p></div><Select value={member.role} onValueChange={async (role) => { await update.mutateAsync({ params: { id: teamId, userId: member.userId }, body: { role: role as "owner" | "admin" | "member" } }); await refresh(); }}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="owner">Owner</SelectItem><SelectItem value="admin">Admin</SelectItem><SelectItem value="member">Member</SelectItem></SelectContent></Select><Button variant="ghost" size="icon" onClick={async () => { await remove.mutateAsync({ params: { id: teamId, userId: member.userId } }); await refresh(); }}><IconTrash /></Button></div>)}</div></div>;
}
