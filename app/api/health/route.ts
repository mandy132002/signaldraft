import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Safe env check for Vercel debugging — never returns secret values. */
export async function GET() {
  const rawAuthUrl = process.env.AUTH_URL?.trim() || null;
  let authUrl = rawAuthUrl;
  let authUrlProblem: string | null = null;

  if (rawAuthUrl?.startsWith("AUTH_URL=")) {
    authUrlProblem =
      'AUTH_URL value includes "AUTH_URL=" prefix — set the value to only https://signaldraft-sand.vercel.app';
    authUrl = rawAuthUrl.replace(/^AUTH_URL=/, "");
  }
  if (authUrl && !/^https?:\/\//.test(authUrl)) {
    authUrlProblem = "AUTH_URL must start with https:// (no variable name, no quotes)";
  }

  const env = {
    AUTH_SECRET: Boolean(process.env.AUTH_SECRET),
    AUTH_URL: authUrl,
    AUTH_URL_RAW: rawAuthUrl,
    GOOGLE_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    MONGODB_URI: Boolean(process.env.MONGODB_URI),
    MONGODB_DB: process.env.MONGODB_DB || "signaldraft",
    GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
    NODE_ENV: process.env.NODE_ENV || null,
  };

  const required = ["AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MONGODB_URI"] as const;
  const missing = required.filter((k) => !env[k]);

  return NextResponse.json({
    ok: missing.length === 0 && !authUrlProblem,
    missing,
    authUrlProblem,
    env,
  });
}
