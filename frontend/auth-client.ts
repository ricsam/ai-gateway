import { createAuthClient } from "better-auth/react";
import { genericOAuthClient, usernameClient } from "better-auth/client/plugins";
import env from "@/env";

export const authClient = createAuthClient({ baseURL: `${env.BASE_URL}/api/auth`, plugins: [usernameClient(), genericOAuthClient()] });
export const { signOut, useSession } = authClient;

export async function signInWithPassword(username: string, password: string): Promise<void> {
  const result = await authClient.signIn.username({ username, password, rememberMe: true, callbackURL: `${env.BASE_URL}/chat` });
  if (result.error) throw new Error(result.error.message || "Invalid username or password");
}

export async function signInWithOidc(providerId: string): Promise<void> {
  const result = await authClient.signIn.oauth2({ providerId, callbackURL: `${env.BASE_URL}/chat`, errorCallbackURL: `${env.BASE_URL}/?error=oidc`, requestSignUp: true });
  if (result.error) throw new Error(result.error.message || "Could not start external sign-in");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const result = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
  if (result.error) throw new Error(result.error.message || "Could not change password");
}
