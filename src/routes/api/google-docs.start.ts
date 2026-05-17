import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/integrations/auth/config";
import { tryDevAutoLoginSession } from "@/integrations/auth/dev-bypass";
import { buildAuthorizeUrl, isGoogleDocsConfigured } from "@/integrations/google-docs/oauth";
import { createState } from "@/integrations/google-docs/state";
import { env } from "@/utils/env";
import { logger } from "@/utils/logger";

const NONCE_COOKIE = "gdocs_oauth_nonce";

function buildNonceCookie(nonce: string): string {
	const secure = env.APP_URL.startsWith("https://");
	const parts = [
		`${NONCE_COOKIE}=${nonce}`,
		"Path=/api/google-docs",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=600",
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

async function handler({ request }: { request: Request }) {
	if (!isGoogleDocsConfigured()) {
		return new Response("Google Docs integration is not configured", { status: 503 });
	}

	const realSession = await auth.api.getSession({ headers: request.headers });
	const session = realSession ?? (await tryDevAutoLoginSession());
	if (!session?.user) {
		const loginUrl = new URL("/auth/login", env.APP_URL);
		return Response.redirect(loginUrl.toString(), 302);
	}

	const { state, nonce } = createState(session.user.id);
	const authorizeUrl = buildAuthorizeUrl(state);

	logger.info("Starting Google Docs OAuth flow", { userId: session.user.id });

	return new Response(null, {
		status: 302,
		headers: {
			Location: authorizeUrl,
			"Set-Cookie": buildNonceCookie(nonce),
		},
	});
}

export const Route = createFileRoute("/api/google-docs/start")({
	server: {
		handlers: {
			GET: handler,
		},
	},
});
