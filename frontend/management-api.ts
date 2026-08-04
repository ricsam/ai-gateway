export class ManagementApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export async function managementFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/management/v1${path}`, { credentials: "include", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const contentType = response.headers.get("content-type") ?? "";
  const value = contentType.includes("application/json") ? await response.json() as any : null;
  if (!response.ok) throw new ManagementApiError(value?.error?.message || `Management request failed (${response.status})`, response.status, value?.error?.code || "request_failed");
  return value as T;
}

export async function managementListAll<T>(path: string): Promise<T[]> {
  const data: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += 100) {
    const result = await managementFetch<{ data: T[]; pagination?: { total: number } }>(`${path}${separator}limit=100&offset=${offset}`);
    data.push(...result.data);
    if (result.data.length < 100 || (result.pagination && data.length >= result.pagination.total)) return data;
  }
}
