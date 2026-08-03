import { Outlet, createFileRoute } from "@richie-router/react";
export const Route = createFileRoute("/admin/teams")({ component: () => <Outlet /> });
