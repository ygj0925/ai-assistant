import { NextRequest, NextResponse } from "next/server";
import { isOrganizationSsoHost, organizationSsoSessionCookie, organizationSsoSettings, requestOrganizationSso, scopedSsoBearer } from "@/lib/organization-sso-server";

export async function GET(request: NextRequest) {
  const settings = organizationSsoSettings();
  const authorization = scopedSsoBearer(request.cookies.get(organizationSsoSessionCookie)?.value);
  const upstream = settings && isOrganizationSsoHost(request, settings) && authorization
    ? await requestOrganizationSso(settings, "/workspace", { authorization }) : undefined;
  return new NextResponse(null, { status: upstream?.ok ? 204 : 401, headers: { "Cache-Control": "no-store" } });
}
