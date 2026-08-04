import { createFileRoute, useNavigate } from "@richie-router/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePassword, useSession } from "../auth-client";

export const Route = createFileRoute("/change-password")({ component: ChangePassword });
function ChangePassword() {
  const navigate = useNavigate(); const { data: session } = useSession(); const [currentPassword, setCurrent] = useState(""); const [newPassword, setNext] = useState(""); const [confirm, setConfirm] = useState(""); const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (newPassword !== confirm) return setError("Passwords do not match"); try { await changePassword(currentPassword, newPassword); const role = (session?.user as { role?: string })?.role; window.location.href = role === "admin" ? "/admin" : "/chat"; } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not change password"); } };
  return <main className="min-h-screen grid place-items-center p-6"><Card className="w-full max-w-md"><CardHeader><CardTitle>Change your password</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}><div className="space-y-2"><Label>Current password</Label><Input type="password" value={currentPassword} onChange={(event) => setCurrent(event.target.value)} required /></div><div className="space-y-2"><Label>New password</Label><Input type="password" minLength={12} value={newPassword} onChange={(event) => setNext(event.target.value)} required /></div><div className="space-y-2"><Label>Confirm new password</Label><Input type="password" minLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></div>{error && <p className="text-sm text-destructive">{error}</p>}<Button className="w-full">Change password</Button></form></CardContent></Card></main>;
}
