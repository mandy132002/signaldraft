import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js config — used by middleware.
 * Do NOT add providers or DB imports here (middleware runs on Edge).
 */
export default {
  providers: [],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      if (path.startsWith("/login") || path.startsWith("/api/auth")) {
        return true;
      }
      return !!auth;
    },
  },
  trustHost: true,
} satisfies NextAuthConfig;
