import { NextResponse } from "next/server";
import { listRuns } from "@/lib/db";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const runs = await listRuns(gate.userId);
  return NextResponse.json({ runs });
}
