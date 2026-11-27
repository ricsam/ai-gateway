import { createFileRoute } from "@richie-router/react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "../../api";
import { managementListAll } from "../../management-api";
import { AnalyticsControls } from "../../ui/analytics-controls";
import { useAnalyticsPreferences } from "../../ui/use-analytics-preferences";
import { BalanceBurndownChart, CreditsConsumedChart, TokensConsumedChart, UsageByModelChart, formatTokenCount } from "../../ui/analytics-charts";
import {
  AnalyticsSelectionPicker,
  EMPTY_SELECTION,
  isEmptySelection,
  selectionQuery,
  type AnalyticsSelection,
  type SelectableGroup,
  type SelectableUser,
} from "../../ui/analytics-selection";
import { ModelDeepDiveTable } from "../../ui/model-deep-dive-table";
import { GroupSummaryTable, UserSummaryTable } from "../../ui/analytics-summary-tables";
import { ThroughputCard } from "../../ui/throughput-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatWindow } from "@/lib/analytics-time";

export const Route = createFileRoute("/admin/analytics")({ component: Analytics });

// Kept for the browser tab's session, so that the selection survives visiting a user's page.
const SELECTION_KEY = "admin-analytics-selection";

function readSelection(): AnalyticsSelection {
  try {
    const value = JSON.parse(sessionStorage.getItem(SELECTION_KEY) || "null") as Partial<AnalyticsSelection> | null;
    const ids = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
    return { userIds: ids(value?.userIds), groupIds: ids(value?.groupIds) };
  } catch {
    return EMPTY_SELECTION;
  }
}

function useSelection() {
  const [selection, setSelection] = useState(readSelection);
  const update = (next: AnalyticsSelection) => {
    try {
      sessionStorage.setItem(SELECTION_KEY, JSON.stringify(next));
    } catch {}
    setSelection(next);
  };
  return [selection, update] as const;
}

function Analytics() {
  const analytics = useAnalyticsPreferences();
  const [selection, setSelection] = useSelection();
  const people = useQuery({
    queryKey: ["admin-analytics-people"],
    queryFn: async () => {
      const [users, groups] = await Promise.all([managementListAll<SelectableUser>("/users"), managementListAll<SelectableGroup>("/groups")]);
      return { users, groups };
    },
  });
  // Forget users and groups that no longer exist, such as ones deleted since they were selected.
  useEffect(() => {
    if (!people.data) return;
    const users = new Set(people.data.users.map((user) => user.id));
    const groups = new Set(people.data.groups.map((group) => group.id));
    const kept = { userIds: selection.userIds.filter((id) => users.has(id)), groupIds: selection.groupIds.filter((id) => groups.has(id)) };
    if (kept.userIds.length !== selection.userIds.length || kept.groupIds.length !== selection.groupIds.length) setSelection(kept);
  }, [people.data]);
  const filtered = !isEmptySelection(selection);
  const scope = selectionQuery(selection);
  const query = { ...analytics.query, ...scope };
  const windowQuery = { ...analytics.windowQuery, ...scope };
  const burndown = api.adminGetAnalyticsBurndown.useQuery({ queryKey: ["admin-analytics-burndown", query], queryData: { query } });
  const consumed = api.adminGetAnalyticsConsumed.useQuery({ queryKey: ["admin-analytics-consumed", query], queryData: { query } });
  const modelUsage = api.adminGetAnalyticsByModel.useQuery({ queryKey: ["admin-analytics-model", query], queryData: { query: { ...query, topN: "5" } } });
  const modelSummary = api.adminGetAnalyticsModelSummary.useQuery({ queryKey: ["admin-analytics-model-summary", query], queryData: { query } });
  const tokens = api.adminGetAnalyticsTokensConsumed.useQuery({ queryKey: ["admin-analytics-tokens", query], queryData: { query } });
  const throughput = api.adminGetAnalyticsThroughput.useQuery({ queryKey: ["admin-analytics-throughput", windowQuery], queryData: { query: windowQuery } });
  const users = api.adminGetAnalyticsUserSummary.useQuery({ queryKey: ["admin-analytics-users", windowQuery], queryData: { query: windowQuery } });
  const groups = api.adminGetAnalyticsGroupSummary.useQuery({ queryKey: ["admin-analytics-groups", windowQuery], queryData: { query: windowQuery } });
  const refresh = () => void queryClient.invalidateQueries({ predicate: (item) => String(item.queryKey[0]).startsWith("admin-analytics") });
  const custom = analytics.custom ? formatWindow(new Date(analytics.custom.start), new Date(analytics.custom.end)) : null;
  const subject = filtered ? "Usage of the selected users and the current members of the selected groups" : "System-wide usage, credits, model, user, and group trends";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            {subject}
            {custom ? `, ${custom}.` : "."}
          </p>
        </div>
        <AnalyticsControls analytics={analytics} onRefresh={refresh} />
      </div>
      <AnalyticsSelectionPicker users={people.data?.users ?? []} groups={people.data?.groups ?? []} value={selection} onChange={setSelection} isLoading={people.isLoading} />
      {people.isError && <p className="text-sm text-destructive">Users and groups could not be loaded for the filter.</p>}
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label={filtered ? "Current balance of the selection" : "Current balance"} value={`$${(burndown.data?.payload.currentBalance ?? 0).toFixed(2)}`} />
        <Metric label="Credits consumed" value={`$${(consumed.data?.payload.data.reduce((sum, row) => sum + row.consumed, 0) ?? 0).toFixed(4)}`} />
        <Metric label="Tokens" value={formatTokenCount(tokens.data?.payload.summary.total ?? 0)} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Chart title="Credit balance">
          <BalanceBurndownChart data={burndown.data?.payload.data ?? []} currentBalance={analytics.custom ? undefined : burndown.data?.payload.currentBalance} scale={analytics.scale} isLoading={burndown.isLoading} />
        </Chart>
        <Chart title="Credits consumed">
          <CreditsConsumedChart data={consumed.data?.payload.data ?? []} scale={analytics.scale} isLoading={consumed.isLoading} />
        </Chart>
        <Chart title="Token usage">
          <TokensConsumedChart data={tokens.data?.payload.data ?? []} scale={analytics.scale} isLoading={tokens.isLoading} />
        </Chart>
        <Chart title="Usage by model">
          <UsageByModelChart data={modelUsage.data?.payload.data ?? []} models={modelUsage.data?.payload.models ?? []} scale={analytics.scale} isLoading={modelUsage.isLoading} />
        </Chart>
      </div>
      <ThroughputCard data={throughput.data?.payload} isLoading={throughput.isLoading} isError={throughput.isError} />
      <Card>
        <CardHeader>
          <CardTitle>Model breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <ModelDeepDiveTable models={modelSummary.data?.payload.models ?? []} isLoading={modelSummary.isLoading} />
        </CardContent>
      </Card>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Per-user summary</CardTitle>
            <CardDescription>{filtered ? "Active days and credit attribution of the selected people." : "Active days and credit attribution."}</CardDescription>
          </CardHeader>
          <CardContent>
            <UserSummaryTable users={users.data?.payload.users ?? []} isLoading={users.isLoading} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Per-group summary</CardTitle>
            <CardDescription>
              {filtered
                ? "The selected groups, or the groups of the selected users; only the selected people's usage counts."
                : "Current-membership attribution; multi-group users contribute to each applicable group."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GroupSummaryTable groups={groups.data?.payload.groups ?? []} isLoading={groups.isLoading} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function Chart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
