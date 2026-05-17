import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/integrations/auth/config";
import { tryDevAutoLoginSession } from "@/integrations/auth/dev-bypass";
import {
	exchangeCodeForTokens,
	fetchUserInfo,
	isGoogleDocsConfigured,
	persistConnection,
} from "@/integrations/google-docs/oauth";
import { verifyState } from "@/integrations/google-docs/state";
import { env } from "@/utils/env";
import { logger } from "@/utils/logger";

const NONCE_COOKIE = "gdocs_oauth_nonce";
const RETURN_PATH = "/dashboard";

function clearedNonceCookie(): string {
	const secure = env.APP_URL.startsWith("https://");
	const parts = [
		`${NONCE_COOKIE}=`,
		"Path=/api/google-docs",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

function parseCookies(header: string | null): Record<string, string> {
	if (!header) return {};
	const map: Record<string, string> = {};
	for (const segment of header.split(";")) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const i = trimmed.indexOf("=");
		if (i === -1) continue;
		map[trimmed.slice(0, i)] = decodeURIComponent(trimmed.slice(i + 1));
	}
	return map;
}

function redirectBack(status: "connected" | "error", reason?: string): Response {
	const url = new URL(RETURN_PATH, env.APP_URL);
	url.searchParams.set("googleDocs", status);
	if (reason) url.searchParams.set("reason", reason);
	return new Response(null, {
		status: 302,
		headers: {
			Location: url.toString(),
			"Set-Cookie": clearedNonceCookie(),
		},
	});
}

async function handler({ request }: { request: Request }) {
	if (!isGoogleDocsConfigured()) {
		return new Response("Google Docs integration is not configured", { status: 503 });
	}

	const url = new URL(request.url);
	const error = url.searchParams.get("error");
	if (error) {
		logger.warn("Google Docs OAuth returned an error", { error });
		return redirectBack("error", error);
	}

	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		return redirectBack("error", "missing_code_or_state");
	}

	const cookies = parseCookies(request.headers.get("cookie"));
	const nonce = cookies[NONCE_COOKIE];
	if (!nonce) {
		return redirectBack("error", "missing_nonce");
	}

	const payload = verifyState(state, nonce);
	if (!payload) {
		return redirectBack("error", "invalid_state");
	}

	const realSession = await auth.api.getSession({ headers: request.headers });
	const session = realSession ?? (await tryDevAutoLoginSession());
	if (!session?.user || session.user.id !== payload.userId) {
		return redirectBack("error", "session_mismatch");
	}

	try {
		const tokens = await exchangeCodeForTokens(code);
		const info = await fetchUserInfo(tokens.access_token);

		await persistConnection({
			userId: session.user.id,
			tokens,
			googleSub: info.sub,
			googleEmail: info.email,
		});

		logger.info("Google Docs connected", {
			userId: session.user.id,
			googleEmail: info.email,
		});

		return redirectBack("connected");
	} catch (err) {
		logger.error("Google Docs OAuth callback failed", {
			userId: session.user.id,
			error: err,
		});
		return redirectBack("error", "token_exchange_failed");
	}
}

export const Route = createFileRoute("/api/google-docs/callback")({
	server: {
		handlers: {
			GET: handler,
		},
	},
});
