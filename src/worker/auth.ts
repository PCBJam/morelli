/**
 * Session + OAuth helpers. No database: the session is a stateless HMAC-signed
 * cookie {email, exp}, signed with SESSION_SECRET via crypto.subtle. GitHub
 * OAuth only proves the email; authorization is the ALLOWED_EMAILS allowlist.
 */
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from './env';
import { allowedEmails } from './env';

export const SESSION_COOKIE = 'morelli_session';
export const STATE_COOKIE = 'morelli_oauth_state';
export const SESSION_TTL_S = 7 * 24 * 3600;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
    try {
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** `payloadB64.sigB64` where payload is JSON {email, exp(seconds)}. */
export async function createSessionValue(secret: string, email: string, nowMs: number): Promise<string> {
    const payload = b64url(enc.encode(JSON.stringify({ email, exp: Math.floor(nowMs / 1000) + SESSION_TTL_S })));
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
    return `${payload}.${b64url(sig)}`;
}

/** The session's email, or null when missing/forged/expired. Constant-time via crypto.subtle.verify. */
export async function verifySessionValue(secret: string, value: string | undefined, nowMs: number): Promise<string | null> {
    if (!value) return null;
    const dot = value.indexOf('.');
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const sig = b64urlDecode(value.slice(dot + 1));
    if (!sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig as unknown as BufferSource, enc.encode(payload));
    if (!ok) return null;
    const raw = b64urlDecode(payload);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as { email?: string; exp?: number };
        if (typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') return null;
        if (parsed.exp * 1000 < nowMs) return null;
        return parsed.email;
    } catch {
        return null;
    }
}

export function randomHex(byteLen: number): string {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function setSessionCookie(c: Context<AppEnv>, value: string): void {
    setCookie(c, SESSION_COOKIE, value, {
        httpOnly: true,
        secure: true, // localhost counts as a secure context in every browser we care about
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_TTL_S,
    });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function setStateCookie(c: Context<AppEnv>, state: string): void {
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/api/auth', maxAge: 600 });
}

export function readAndClearStateCookie(c: Context<AppEnv>): string | undefined {
    const v = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/api/auth' });
    return v;
}

/** True when this GitHub-verified email is allowlisted (case-insensitive). */
export function isAllowedEmail(c: Context<AppEnv>, email: string): boolean {
    return allowedEmails(c.env).includes(email.trim().toLowerCase());
}

/** Auth middleware for every /api route except /api/auth/*. */
export async function requireSession(c: Context<AppEnv>, next: Next): Promise<Response | void> {
    const email = await verifySessionValue(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), Date.now());
    if (!email) return c.json({ error: 'unauthenticated' }, 401);
    c.set('email', email);
    await next();
}
