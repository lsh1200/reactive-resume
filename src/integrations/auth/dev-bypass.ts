import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle";
import { db } from "@/integrations/drizzle/client";
import { env } from "@/utils/env";
import type { AuthSession } from "./types";

let cached: { session: AuthSession; loadedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function isDevAutoLoginEnabled(): boolean {
	return process.env.NODE_ENV === "development" && Boolean(env.DEV_AUTO_LOGIN_USER_ID);
}

export async function tryDevAutoLoginSession(): Promise<AuthSession | null> {
	if (!isDevAutoLoginEnabled()) return null;
	const userId = env.DEV_AUTO_LOGIN_USER_ID;
	if (!userId) return null;

	if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS && cached.session.user.id === userId) {
		return cached.session;
	}

	const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1);
	if (!user) return null;

	const now = new Date();
	const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
	const session: AuthSession = {
		session: {
			id: "dev-auto-login",
			userId: user.id,
			token: "dev-auto-login",
			expiresAt,
			ipAddress: null,
			userAgent: null,
			createdAt: now,
			updatedAt: now,
		} as AuthSession["session"],
		user: {
			...user,
			image: user.image ?? undefined,
		} as AuthSession["user"],
	};
	cached = { session, loadedAt: Date.now() };
	return session;
}
