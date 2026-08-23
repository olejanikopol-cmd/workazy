type GithubOidcHeader = {
  alg?: string;
  kid?: string;
};

type GithubOidcClaims = {
  aud?: string | string[];
  event_name?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
  ref?: string;
  repository?: string;
  workflow_ref?: string;
};

type GithubJwk = JsonWebKey & { kid?: string };

const EXPECTED_AUDIENCE = "workazy-hourly";
const EXPECTED_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_REPOSITORY = "olejanikopol-cmd/workazy";
const EXPECTED_WORKFLOW = `${EXPECTED_REPOSITORY}/.github/workflows/hourly-reminder.yml@refs/heads/main`;

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseJsonPart<T>(part: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as T;
  } catch {
    return null;
  }
}

function audienceMatches(audience: string | string[] | undefined) {
  return Array.isArray(audience)
    ? audience.includes(EXPECTED_AUDIENCE)
    : audience === EXPECTED_AUDIENCE;
}

export async function verifyGithubActionsRequest(request: Request): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;

  const token = authorization.slice("Bearer ".length).trim();
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) return false;

  const header = parseJsonPart<GithubOidcHeader>(encodedHeader);
  const claims = parseJsonPart<GithubOidcClaims>(encodedPayload);
  if (!header?.kid || header.alg !== "RS256" || !claims) return false;

  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== EXPECTED_ISSUER ||
    !audienceMatches(claims.aud) ||
    claims.repository !== EXPECTED_REPOSITORY ||
    claims.ref !== "refs/heads/main" ||
    claims.workflow_ref !== EXPECTED_WORKFLOW ||
    !claims.exp || claims.exp <= now ||
    (claims.nbf !== undefined && claims.nbf > now) ||
    !["schedule", "workflow_dispatch", "push"].includes(claims.event_name ?? "")
  ) {
    return false;
  }

  try {
    const response = await fetch(`${EXPECTED_ISSUER}/.well-known/jwks`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const payload = await response.json() as { keys?: GithubJwk[] };
    const jwk = payload.keys?.find((candidate) => candidate.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
  } catch {
    return false;
  }
}
