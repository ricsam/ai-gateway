import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";
import env from "@/env";

export const authClient = createAuthClient({ baseURL: `${env.BASE_URL}/api/auth`, plugins: [usernameClient()] });
export const { signOut, useSession } = authClient;

export async function signInWithPassword(username: string, password: string): Promise<void> {
  const result = await authClient.signIn.username({ username, password, rememberMe: true, callbackURL: `${env.BASE_URL}/chat` });
  if (result.error) throw new Error(result.error.message || "Invalid username or password");
}

export async function signInWithOidc(providerId: string): Promise<void> {
  // Better Auth 1.7 serves Generic OAuth providers through the standard social sign-in path.
  const result = await authClient.signIn.social({ provider: providerId, callbackURL: `${env.BASE_URL}/chat`, errorCallbackURL: `${env.BASE_URL}/?error=oidc`, requestSignUp: true });
  if (result.error) throw new Error(result.error.message || "Could not start external sign-in");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const result = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
  if (result.error) throw new Error(result.error.message || "Could not change password");
}
