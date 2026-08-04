import { eq } from "drizzle-orm";
import db from "@/db";
import { authenticateRequest } from "./auth";
import { userTable } from "./schema";

export class AccessDeniedError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
  }
}

export async function requireAuth(request: Request) {
  const principal = await authenticateRequest(request);
  if (!principal) throw new AccessDeniedError(401, "Unauthorized");

  const [user] = await db
    .select()
    .from(userTable)
    .where(eq(userTable.id, principal.userId))
    .limit(1);
  if (!user?.enabled) throw new AccessDeniedError(403, "Account disabled");
  if (user.mustChangePassword) throw new AccessDeniedError(403, "Password change required");
  return user;
}

export async function requireAdmin(request: Request) {
  const user = await requireAuth(request);
  if (user.role !== "admin") throw new AccessDeniedError(403, "Forbidden");
  return user;
}
