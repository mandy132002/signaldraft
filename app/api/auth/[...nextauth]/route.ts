import { handlers } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { GET: authGet, POST: authPost } = handlers;

function authConfigHint() {
  const missing: string[] = [];
  if (!process.env.AUTH_SECRET) missing.push("AUTH_SECRET");
  if (!process.env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!process.env.MONGODB_URI) missing.push("MONGODB_URI");
  return missing;
}

async function wrap(fn: (req: Request) => Promise<Response>, req: Request) {
  const missing = authConfigHint();
  if (missing.length) {
    console.error("Auth misconfigured — missing env:", missing.join(", "));
    return Response.json(
      {
        error: "Auth is not configured on the server",
        missing,
        hint: "Add these in Vercel → Settings → Environment Variables, then redeploy.",
      },
      { status: 503 }
    );
  }
  try {
    return await fn(req);
  } catch (err) {
    console.error("Auth handler error", err);
    return Response.json(
      {
        error: "Auth handler failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  return wrap((r) => authGet(r as Parameters<typeof authGet>[0]), req);
}

export async function POST(req: Request) {
  return wrap((r) => authPost(r as Parameters<typeof authPost>[0]), req);
}
