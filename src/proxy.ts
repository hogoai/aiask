import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const privateViews = new Set(["inbox", "calendar", "todos"]);

function isPrivateRequest(request: NextRequest) {
  if (request.nextUrl.pathname === "/workspace" || request.nextUrl.pathname.startsWith("/workspace/")) return true;
  if (request.nextUrl.pathname !== "/") return false;
  return privateViews.has(request.nextUrl.searchParams.get("view") ?? "") || request.nextUrl.searchParams.get("capture") === "1";
}

export async function proxy(request: NextRequest) {
  if (!isPrivateRequest(request)) return NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // Keep the current browser-only demo usable until the owner configures an Auth project.
  if (!url || !publishableKey) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims || error) {
    const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", next);
    const redirect = NextResponse.redirect(loginUrl);
    response.cookies.getAll().forEach(cookie => redirect.cookies.set(cookie));
    return redirect;
  }

  return response;
}

export const config = { matcher: ["/workspace/:path*", "/"] };
