import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { createGmailDraft } from "@/lib/gmail";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;

  const body = (await req.json()) as {
    subject?: string;
    emailBody?: string;
    to?: string;
  };

  const subject = (body.subject || "").trim();
  const emailBody = (body.emailBody || "").trim();
  if (!emailBody) {
    return NextResponse.json({ error: "Email body is required" }, { status: 400 });
  }

  // Prefer tokens from the latest OAuth consent (JWT). Auth.js does not
  // update MongoDB account.scope on reconnect when using JWT sessions.
  const jwt = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
  });

  const result = await createGmailDraft({
    userId: gate.userId,
    subject: subject || "(no subject)",
    body: emailBody,
    to: body.to,
    jwtTokens: jwt
      ? {
          access_token: jwt.googleAccessToken,
          refresh_token: jwt.googleRefreshToken,
          expires_at: jwt.googleExpiresAt,
          scope: jwt.googleScope,
        }
      : null,
  });

  if (!result.ok) {
    const status =
      result.code === "NEEDS_GMAIL_SCOPE" ||
      result.code === "NO_ACCOUNT" ||
      result.code === "REFRESH_FAILED" ||
      result.code === "GMAIL_API_DISABLED"
        ? 403
        : 502;
    return NextResponse.json(
      {
        error: result.error,
        code: result.code,
        activationUrl: "activationUrl" in result ? result.activationUrl : undefined,
      },
      { status }
    );
  }

  return NextResponse.json({
    ok: true,
    draftId: result.draftId,
    messageId: result.messageId,
    draftsUrl: "https://mail.google.com/mail/#drafts",
  });
}
