import { useMemo, useState } from "react";
import { IconChevronDown, IconUsersGroup, IconX } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** The people analytics cover: these users and the current members of these groups. Empty: everyone. */
export interface AnalyticsSelection {
  userIds: string[];
  groupIds: string[];
}

export interface SelectableUser {
  id: string;
  username: string;
  name: string;
  email: string;
}

export interface SelectableGroup {
  id: string;
  name: string;
  memberCount?: number;
}

export const EMPTY_SELECTION: AnalyticsSelection = { userIds: [], groupIds: [] };
// Matches the management API's limit on IDs per request.
export const MAX_SELECTION = 100;
// Rows rendered per section; searching narrows longer lists.
const VISIBLE_ROWS = 100;

export function isEmptySelection(selection: AnalyticsSelection): boolean {
  return !selection.userIds.length && !selection.groupIds.length;
}

/** Query parameters of the admin analytics endpoints for a selection. */
export function selectionQuery(selection: AnalyticsSelection): { userId?: string[]; groupId?: string[] } {
  return {
    ...(selection.userIds.length ? { userId: selection.userIds } : {}),
    ...(selection.groupIds.length ? { groupId: selection.groupIds } : {}),
  };
}

function matches(query: string, ...values: (string | undefined)[]): boolean {
  return values.some((value) => value?.toLowerCase().includes(query));
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

/** A searchable picker of users and groups, with the selection shown as removable badges. */
export function AnalyticsSelectionPicker({
  users,
  groups,
  value,
  onChange,
  isLoading,
}: {
  users: SelectableUser[];
  groups: SelectableGroup[];
  value: AnalyticsSelection;
  onChange: (selection: AnalyticsSelection) => void;
  isLoading?: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const shownGroups = useMemo(() => groups.filter((group) => matches(query, group.name)), [groups, query]);
  const shownUsers = useMemo(() => users.filter((user) => matches(query, user.name, user.username, user.email)), [users, query]);
  const userById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const selected = value.userIds.length + value.groupIds.length;
  const full = selected >= MAX_SELECTION;
  const names = [
    ...value.groupIds.map((id) => groupById.get(id)?.name ?? "Unknown group"),
    ...value.userIds.map((id) => userById.get(id)?.name ?? "Unknown user"),
  ];
  const summary = !selected ? "All users" : names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  const row = (checked: boolean, onToggle: () => void, label: string, detail: string) => (
    <label className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-(--primary)" checked={checked} disabled={!checked && full} onChange={onToggle} />
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">People</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="min-w-48 max-w-80 justify-between" aria-label={`People: ${summary}`}>
              <IconUsersGroup className="text-muted-foreground" />
              <span className="truncate">{summary}</span>
              <IconChevronDown className="ml-auto opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            <div className="border-b p-2">
              <Input autoFocus placeholder="Search users and groups" aria-label="Search users and groups" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="max-h-80 overflow-y-auto p-1">
              {isLoading ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">Loading users and groups…</p>
              ) : (
                <>
                  {!!shownGroups.length && (
                    <fieldset>
                      <legend className="px-2 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Groups</legend>
                      {shownGroups.slice(0, VISIBLE_ROWS).map((group) => (
                        <div key={group.id}>
                          {row(
                            value.groupIds.includes(group.id),
                            () => onChange({ ...value, groupIds: toggle(value.groupIds, group.id) }),
                            group.name,
                            group.memberCount === undefined ? "Current members" : `${group.memberCount} current ${group.memberCount === 1 ? "member" : "members"}`,
                          )}
                        </div>
                      ))}
                    </fieldset>
                  )}
                  {!!shownUsers.length && (
                    <fieldset>
                      <legend className="px-2 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Users</legend>
                      {shownUsers.slice(0, VISIBLE_ROWS).map((user) => (
                        <div key={user.id}>
                          {row(value.userIds.includes(user.id), () => onChange({ ...value, userIds: toggle(value.userIds, user.id) }), user.name, `@${user.username} · ${user.email}`)}
                        </div>
                      ))}
                    </fieldset>
                  )}
                  {!shownGroups.length && !shownUsers.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No matching users or groups</p>}
                  {(shownGroups.length > VISIBLE_ROWS || shownUsers.length > VISIBLE_ROWS) && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">Search to find more.</p>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t p-2 text-xs text-muted-foreground">
              <span>{full ? `At most ${MAX_SELECTION} users and groups` : selected ? `${selected} selected` : "Nothing selected: all users"}</span>
              <Button variant="ghost" size="sm" disabled={!selected} onClick={() => onChange(EMPTY_SELECTION)}>
                Clear
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {value.groupIds.map((id) => (
        <SelectedBadge key={`group-${id}`} label={groupById.get(id)?.name ?? "Unknown group"} kind="group" onRemove={() => onChange({ ...value, groupIds: value.groupIds.filter((entry) => entry !== id) })} />
      ))}
      {value.userIds.map((id) => (
        <SelectedBadge key={`user-${id}`} label={userById.get(id)?.name ?? "Unknown user"} kind="user" onRemove={() => onChange({ ...value, userIds: value.userIds.filter((entry) => entry !== id) })} />
      ))}
    </div>
  );
}

function SelectedBadge({ label, kind, onRemove }: { label: string; kind: "user" | "group"; onRemove: () => void }) {
  return (
    <Badge variant={kind === "group" ? "secondary" : "outline"} className="mb-1.5 gap-1 pr-1">
      {kind === "group" && <IconUsersGroup className="size-3" />}
      {label}
      <button type="button" className="rounded-sm p-0.5 hover:bg-foreground/10" aria-label={`Remove ${label}`} onClick={onRemove}>
        <IconX className="size-3" />
      </button>
    </Badge>
  );
}
