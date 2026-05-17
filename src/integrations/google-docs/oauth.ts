import { eq } from "drizzle-orm";
import { db } from "@/integrations/drizzle/client";
import { googleDocsConnection } from "@/integrations/drizzle/schema";
import { env } from "@/utils/env";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const GOOGLE_DOCS_REDIRECT_PATH = "/api/google-docs/callback";

export const GOOGLE_DOCS_SCOPES = [
	"openid",
	"email",
	"https://www.googleapis.com/auth/documents",
	"https://www.googleapis.com/auth/drive.file",
] as const;

const ACCESS_TOKEN_REFRESH_LEEWAY_MS = 60_000;

type TokenResponse = {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope: string;
	token_type: string;
	id_token?: string;
};

type UserInfoResponse = {
	sub: string;
	email: string;
	name?: string;
	picture?: string;
};

export class GoogleDocsConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoogleDocsConfigError";
	}
}

export class GoogleDocsNotConnectedError extends Error {
	constructor() {
		super("Google Docs is not connected for this user");
		this.name = "GoogleDocsNotConnectedError";
	}
}

export class GoogleDocsTokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoogleDocsTokenError";
	}
}

function requireClientCredentials(): { clientId: string; clientSecret: string } {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		throw new GoogleDocsConfigError(
			"GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured to use the Google Docs integration",
		);
	}
	return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

export function isGoogleDocsConfigured(): boolean {
	return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function getRedirectUri(): string {
	return new URL(GOOGLE_DOCS_REDIRECT_PATH, env.APP_URL).toString();
}

export function buildAuthorizeUrl(state: string): string {
	const { clientId } = requireClientCredentials();
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: getRedirectUri(),
		response_type: "code",
		scope: GOOGLE_DOCS_SCOPES.join(" "),
		access_type: "offline",
		include_granted_scopes: "true",
		prompt: "consent",
		state,
	});
	return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
	const { clientId, clientSecret } = requireClientCredentials();
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: getRedirectUri(),
			grant_type: "authorization_code",
		}),
	});
	if (!response.ok) {
		throw new GoogleDocsTokenError(`Token exchange failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as TokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
	const { clientId, clientSecret } = requireClientCredentials();
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "refresh_token",
		}),
	});
	if (!response.ok) {
		throw new GoogleDocsTokenError(`Token refresh failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as TokenResponse;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
	const response = await fetch(GOOGLE_USERINFO_URL, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		throw new GoogleDocsTokenError(`Userinfo fetch failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as UserInfoResponse;
}

export async function revokeToken(token: string): Promise<void> {
	const body = new URLSearchParams({ token });
	await fetch(GOOGLE_REVOKE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	}).catch(() => {
		// Revocation is best-effort; ignore network failures.
	});
}

export async function persistConnection(input: {
	userId: string;
	tokens: TokenResponse;
	googleSub: string;
	googleEmail: string;
	previousRefreshToken?: string | null;
}): Promise<void> {
	const expiresAt = new Date(Date.now() + input.tokens.expires_in * 1000);
	const refreshToken = input.tokens.refresh_token ?? input.previousRefreshToken ?? null;

	await db
		.insert(googleDocsConnection)
		.values({
			userId: input.userId,
			googleSub: input.googleSub,
			googleEmail: input.googleEmail,
			accessToken: input.tokens.access_token,
			refreshToken,
			scope: input.tokens.scope,
			expiresAt,
		})
		.onConflictDoUpdate({
			target: googleDocsConnection.userId,
			set: {
				googleSub: input.googleSub,
				googleEmail: input.googleEmail,
				accessToken: input.tokens.access_token,
				refreshToken,
				scope: input.tokens.scope,
				expiresAt,
			},
		});
}

export async function getConnection(userId: string) {
	const [row] = await db
		.select()
		.from(googleDocsConnection)
		.where(eq(googleDocsConnection.userId, userId))
		.limit(1);
	return row ?? null;
}

export async function getAccessToken(userId: string): Promise<string> {
	const connection = await getConnection(userId);
	if (!connection) throw new GoogleDocsNotConnectedError();

	const now = Date.now();
	const expiresAtMs = connection.expiresAt.getTime();
	if (expiresAtMs > now + ACCESS_TOKEN_REFRESH_LEEWAY_MS) {
		return connection.accessToken;
	}

	if (!connection.refreshToken) {
		throw new GoogleDocsTokenError("Access token expired and no refresh token is stored; user must reconnect");
	}

	const refreshed = await refreshAccessToken(connection.refreshToken);
	const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

	await db
		.update(googleDocsConnection)
		.set({
			accessToken: refreshed.access_token,
			scope: refreshed.scope,
			expiresAt: newExpiresAt,
			...(refreshed.refresh_token ? { refreshToken: refreshed.refresh_token } : {}),
		})
		.where(eq(googleDocsConnection.userId, userId));

	return refreshed.access_token;
}

export async function disconnect(userId: string): Promise<void> {
	const connection = await getConnection(userId);
	if (!connection) return;

	if (connection.refreshToken) {
		await revokeToken(connection.refreshToken);
	} else if (connection.accessToken) {
		await revokeToken(connection.accessToken);
	}

	await db.delete(googleDocsConnection).where(eq(googleDocsConnection.userId, userId));
}
