import { createFileRoute, useNavigate } from "@richie-router/react";
import { useEffect, useState } from "react";
import { IconArrowRight, IconLoader2, IconShieldLock } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithOidc, signInWithPassword, useSession } from "../auth-client";
import { loadPublicConfig, type PublicConfig } from "../config";

export const Route = createFileRoute("/")({ component: LoginPage });

function LoginPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null); const [signingIn, setSigningIn] = useState(false);
  const navigate = useNavigate(); const { data: session } = useSession();
  useEffect(() => { void loadPublicConfig().then((value) => { setConfig(value); if (value.setup.required) navigate({ to: "/setup" }); }).catch((reason) => setError(String(reason))); }, [navigate]);
  useEffect(() => { if (session?.user) { const user = session.user as { role?: string; mustChangePassword?: boolean }; navigate({ to: user.mustChangePassword ? "/change-password" : user.role === "admin" ? "/admin" : "/chat" }); } }, [session, navigate]);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setSigningIn(true); setError(null); try { await signInWithPassword(username, password); window.location.reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not sign in"); setSigningIn(false); } };
  return <main className="min-h-screen bg-background relative overflow-hidden flex items-center justify-center p-6"><div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,color-mix(in_oklab,var(--primary)_16%,transparent),transparent_48%)]" /><div className="relative w-full max-w-md"><div className="mb-8 text-center space-y-3">{config?.brand.logoUrl ? <img src={config.brand.logoUrl} alt="" className="h-10 mx-auto object-contain" /> : <div className="mx-auto h-12 w-12 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shadow-lg"><IconShieldLock size={25} /></div>}<h1 className="text-3xl font-semibold tracking-tight">{config?.brand.name ?? "LLM Proxy"}</h1><p className="text-muted-foreground">{config?.brand.tagline ?? "Secure access to AI models"}</p></div><Card className="shadow-xl border-border/70 backdrop-blur"><CardHeader><CardTitle>Sign in</CardTitle><CardDescription>Use your local administrator or user account.</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}><div className="space-y-2"><Label htmlFor="username">Username</Label><Input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></div><div className="space-y-2"><Label htmlFor="password">Password</Label><Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div><Button className="w-full h-11" disabled={signingIn}>{signingIn ? <IconLoader2 className="animate-spin" /> : <>Sign in<IconArrowRight /></>}</Button>{error && <p className="text-sm text-destructive text-center">{error}</p>}</form>{config?.auth.providers.map((provider) => <Button key={provider.providerKey} type="button" variant="outline" className="w-full mt-3" onClick={() => void signInWithOidc(provider.providerKey)}>Continue with {provider.label}</Button>)}</CardContent></Card></div></main>;
}
