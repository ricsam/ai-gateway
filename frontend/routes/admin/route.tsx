import { Outlet, Link, createFileRoute, useNavigate, useMatchRoute } from "@richie-router/react";
import { useEffect } from "react";
import { useSession } from "../../auth-client";
import { AppShell, adminLinks } from "../../ui/app-shell";

export const Route = createFileRoute("/admin")({ component: AdminLayout });

function AdminLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const match = useMatchRoute();
  const user = session?.user as { role?: string; mustChangePassword?: boolean } | undefined;
  const role = user?.role;
  useEffect(() => { if (!isPending && user?.mustChangePassword) navigate({ to: "/change-password" }); else if (!isPending && role !== "admin") navigate({ to: "/chat" }); }, [isPending, role, user?.mustChangePassword, navigate]);
  if (isPending || role !== "admin" || user?.mustChangePassword) return null;
  return <AppShell><main className="max-w-7xl mx-auto p-5 md:p-8"><div className="mb-6 overflow-x-auto border-b"><div className="flex min-w-max gap-1">{adminLinks.map((item) => <Link key={item.to} to={item.to} className={`flex gap-2 items-center px-3 py-3 text-sm border-b-2 ${match({ to: item.to, fuzzy: true }) ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}><item.icon size={17} />{item.label}</Link>)}</div></div><Outlet /></main></AppShell>;
}
