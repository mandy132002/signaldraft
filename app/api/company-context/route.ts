import { NextResponse } from "next/server";
import { getCompanyContext, saveCompanyContext } from "@/lib/company-context-db";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const context = await getCompanyContext(gate.userId);
  return NextResponse.json(context);
}

export async function PUT(req: Request) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const body = (await req.json()) as {
    senderName?: string;
    senderCompany?: string;
    senderOffer?: string;
  };
  const context = await saveCompanyContext(gate.userId, body);
  return NextResponse.json(context);
}
