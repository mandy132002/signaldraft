import NextAuth from "next-auth";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import type { JWT } from "next-auth/jwt";
import authConfig from "./auth.config";
import { hasGmailScope, upsertGoogleOAuthTokens } from "./lib/gmail";
import getMongoClient from "./lib/mongodb";

function applyGoogleAccountToJwt(token: JWT, account: {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
  scope?: string | null;
}) {
  if (account.access_token) token.googleAccessToken = account.access_token;
  if (account.refresh_token) token.googleRefreshToken = account.refresh_token;
  if (typeof account.expires_at === "number") token.googleExpiresAt = account.expires_at;
  if (account.scope) token.googleScope = account.scope;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: MongoDBAdapter(getMongoClient, {
    databaseName: process.env.MONGODB_DB || "signaldraft",
  }),
  session: { strategy: "jwt" },
  events: {
    async signIn({ user, account }) {
      // JWT strategy does not update Account tokens/scopes on re-auth.
      if (account?.provider === "google" && user.id) {
        await upsertGoogleOAuthTokens(user.id, {
          access_token: account.access_token,
          refresh_token: account.refresh_token,
          expires_at: account.expires_at,
          scope: account.scope,
        });
      }
    },
  },
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, account }) {
      if (user?.id) token.sub = user.id;
      if (account?.provider === "google") {
        applyGoogleAccountToJwt(token, account);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      session.hasGmailCompose = hasGmailScope(token.googleScope);
      return session;
    },
  },
});
