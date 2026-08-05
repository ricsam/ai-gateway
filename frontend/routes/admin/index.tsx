import { createFileRoute, useNavigate } from "@richie-router/react";
import { useEffect } from "react";

export const Route = createFileRoute("/admin/")({
  component: AdminIndex,
});

function AdminIndex() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/admin/analytics" });
  }, [navigate]);
  return null;
}
