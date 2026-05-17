import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/utils/env";

const STATE_TTL_MS = 10 * 60 * 1000;

type StatePayload = {
	userId: string;
	nonce: string;
	expiresAt: number;
};

function base64UrlEncode(buf: Buffer): string {
	return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Buffer {
	const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
	return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
	return base64UrlEncode(createHmac("sha256", env.AUTH_SECRET).update(payload).digest());
}

export function createState(userId: string): { state: string; nonce: string } {
	const nonce = base64UrlEncode(randomBytes(16));
	const payload: StatePayload = { userId, nonce, expiresAt: Date.now() + STATE_TTL_MS };
	const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
	const signature = sign(encoded);
	return { state: `${encoded}.${signature}`, nonce };
}

export function verifyState(state: string, expectedNonce: string): StatePayload | null {
	const [encoded, signature] = state.split(".");
	if (!encoded || !signature) return null;

	const expectedSig = sign(encoded);
	const a = Buffer.from(signature);
	const b = Buffer.from(expectedSig);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	let payload: StatePayload;
	try {
		payload = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as StatePayload;
	} catch {
		return null;
	}
	if (Date.now() > payload.expiresAt) return null;
	if (payload.nonce !== expectedNonce) return null;
	return payload;
}
