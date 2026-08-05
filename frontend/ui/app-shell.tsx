import { Link, useNavigate } from "@richie-router/react";
import { useEffect, useState, type ReactNode } from "react";
import { IconActivity, IconAdjustments, IconBrain, IconChartBar, IconKey, IconLockCog, IconLogout, IconMessage, IconSettings, IconShield, IconShieldLock, IconUsersGroup } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { signOut, useSession } from "../auth-client";
import { loadPublicConfig } from "../config";
import { ModeToggle } from "./mode-toggle";

export function AppShell({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [brandName, setBrandName] = useState("LLM Proxy");
  const role = (session?.user as { role?: string } | undefined)?.role;

  useEffect(() => { void loadPublicConfig().then((config) => setBrandName(config.brand.name)); }, []);
  useEffect(() => { if (!isPending && !session) navigate({ to: "/" }); else if (!isPending && (session?.user as { mustChangePassword?: boolean } | undefined)?.mustChangePassword) navigate({ to: "/change-password" }); }, [isPending, session, navigate]);

  if (isPending || !session) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading...</div>;
  const logout = async () => { await signOut(); navigate({ to: "/" }); };

  return (
    <div className="min-h-screen bg-background">
      <header className="h-16 border-b bg-card/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl h-full mx-auto px-5 flex items-center gap-6">
          <Link to="/chat" className="font-semibold tracking-tight mr-auto">{brandName}</Link>
          <nav className="hidden sm:flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild><Link to="/chat"><IconMessage /> Playground</Link></Button>
            <Button variant="ghost" size="sm" asChild><Link to="/models"><IconBrain /> Model pricing</Link></Button>
            <Button variant="ghost" size="sm" asChild><Link to="/profile"><IconKey /> API & usage</Link></Button>
            {role === "admin" && <Button variant="ghost" size="sm" asChild><Link to="/admin/analytics"><IconShield /> Admin</Link></Button>}
          </nav>
          <ModeToggle />
          <Button variant="ghost" size="icon" onClick={logout} title="Sign out"><IconLogout /></Button>
        </div>
      </header>
      {children}
    </div>
  );
}

export const adminLinks = [
  { to: "/admin/models" as const, label: "Models", icon: IconAdjustments },
  { to: "/admin/users" as const, label: "Users", icon: IconActivity },
  { to: "/admin/groups" as const, label: "Groups", icon: IconUsersGroup },
  { to: "/admin/analytics" as const, label: "Analytics", icon: IconChartBar },
  { to: "/admin/usage" as const, label: "Ledger", icon: IconChartBar },
  { to: "/admin/authentication" as const, label: "Authentication", icon: IconLockCog },
  { to: "/admin/settings" as const, label: "Brand & AWS", icon: IconSettings },
  { to: "/admin/security" as const, label: "Keys & Audit", icon: IconShieldLock },
];
