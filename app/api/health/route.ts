import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Safe env check for Vercel debugging — never returns secret values. */
export async function GET() {
  const env = {
    AUTH_SECRET: Boolean(process.env.AUTH_SECRET),
    AUTH_URL: process.env.AUTH_URL || null,
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
    ok: missing.length === 0,
    missing,
    env,
  });
}
