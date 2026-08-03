import { Outlet, Link, createFileRoute, useNavigate, useMatchRoute } from "@richie-router/react";
import { useEffect } from "react";
import { useSession } from "../../auth-client";
import { AppShell, adminLinks } from "../../ui/app-shell";

export const Route = createFileRoute("/admin")({ component: AdminLayout });

function AdminLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const match = useMatchRoute();
  const role = (session?.user as { role?: string } | undefined)?.role;
  useEffect(() => { if (!isPending && role !== "admin") navigate({ to: "/chat" }); }, [isPending, role, navigate]);
  if (isPending || role !== "admin") return null;
  return <AppShell><main className="max-w-7xl mx-auto p-5 md:p-8"><div className="flex gap-2 border-b mb-6">{adminLinks.map((item) => <Link key={item.to} to={item.to} className={`flex gap-2 items-center px-4 py-3 text-sm border-b-2 ${match({ to: item.to, fuzzy: true }) ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}><item.icon size={17} />{item.label}</Link>)}</div><Outlet /></main></AppShell>;
}
