import { createAuthClient } from "better-auth/react";
import { genericOAuthClient } from "better-auth/client/plugins";
import env from "@/env";

export const authClient = createAuthClient({
  baseURL: `${env.BASE_URL}/api/auth`,
  plugins: [genericOAuthClient()],
});

export const { signOut, useSession } = authClient;

export async function signInWithOidc(providerId: string): Promise<void> {
  await authClient.signIn.oauth2({
    providerId,
    callbackURL: `${env.BASE_URL}/chat`,
    errorCallbackURL: `${env.BASE_URL}/?error=oidc`,
    requestSignUp: true,
  });
}
