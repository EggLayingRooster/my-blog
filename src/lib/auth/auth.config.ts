import type { BetterAuthOptions } from "better-auth";
import { admin } from "better-auth/plugins";

export function createAuthConfig() {
  return {
    emailAndPassword: {
      enabled: true,
    },
    session: {
      storeSessionInDatabase: true,
      cookieCache: {
        enabled: true,
        maxAge: 60,
      },
    },
    plugins: [admin()],
  } satisfies BetterAuthOptions;
}
