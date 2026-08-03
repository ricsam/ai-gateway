import { createFileRoute, useNavigate } from "@richie-router/react";
import { useEffect, useState } from "react";
import { IconArrowRight, IconLoader2, IconShieldLock } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signInWithOidc, useSession } from "../auth-client";
import { loadPublicConfig, type PublicConfig } from "../config";

export const Route = createFileRoute("/")({ component: LoginPage });

function LoginPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const navigate = useNavigate();
  const { data: session } = useSession();

  useEffect(() => { void loadPublicConfig().then(setConfig).catch((reason) => setError(String(reason))); }, []);
  useEffect(() => { if (session?.user) navigate({ to: "/chat" }); }, [session, navigate]);

  const beginSignIn = async () => {
    if (!config) return;
    setSigningIn(true);
    setError(null);
    try { await signInWithOidc(config.auth.providerId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start sign-in"); setSigningIn(false); }
  };

  return (
    <main className="min-h-screen bg-background relative overflow-hidden flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,color-mix(in_oklab,var(--primary)_16%,transparent),transparent_48%)]" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center space-y-3">
          {config?.brand.logoUrl ? <img src={config.brand.logoUrl} alt="" className="h-10 mx-auto object-contain" /> : (
            <div className="mx-auto h-12 w-12 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shadow-lg">
              <IconShieldLock size={25} />
            </div>
          )}
          <h1 className="text-3xl font-semibold tracking-tight">{config?.brand.name ?? "LLM Proxy"}</h1>
          <p className="text-muted-foreground">{config?.brand.tagline ?? "Secure access to AI models"}</p>
        </div>
        <Card className="shadow-xl border-border/70 backdrop-blur">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Your organization manages access through its identity provider.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button className="w-full h-11" disabled={!config || signingIn} onClick={beginSignIn}>
              {signingIn ? <IconLoader2 className="animate-spin" /> : <><span>Continue with {config?.auth.providerLabel ?? "SSO"}</span><IconArrowRight /></>}
            </Button>
            {error && <p className="text-sm text-destructive text-center">{error}</p>}
            <p className="text-xs text-muted-foreground text-center">No proxy password is stored. Authentication is delegated through OpenID Connect.</p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
