import { verifyGithubActionsRequest } from "@/lib/github-oidc";

async function readApiToken(): Promise<string | undefined> {
  if (process.env.WORKAZY_API_TOKEN) return process.env.WORKAZY_API_TOKEN;
  try {
    const { env } = await import("cloudflare:workers");
    return typeof env.WORKAZY_API_TOKEN === "string"
      ? env.WORKAZY_API_TOKEN
      : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  if (!(await verifyGithubActionsRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiToken = await readApiToken();
  if (!apiToken) {
    return Response.json({ error: "Workazy API is not configured" }, { status: 503 });
  }

  const tickUrl = new URL("/api/v1/reminders/tick", request.url);
  const response = await fetch(tickUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
}
