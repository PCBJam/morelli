/**
 * Minimal S3 client for the screenshot bucket (aws4fetch SigV4, region "auto").
 * Retry policy ported from the CI tooling's r2-store.ts: 3 attempts, linear
 * backoff, retrying network errors + 5xx/429 only — conditional-write statuses
 * (412, 304) pass straight through.
 *
 * Keys in this bucket use a URL-safe charset ([A-Za-z0-9._/-], enforced by
 * shared/keys.ts builders), so no path encoding is needed.
 */
import { AwsClient } from 'aws4fetch';
import type { Env } from './env';

const RETRIES = 3;
const BACKOFF_MS = 1000;

export type PutOptions = { contentType?: string; ifMatch?: string; ifNoneMatch?: string };
export type ListOptions = { prefix: string; delimiter?: string; cursor?: string; maxKeys?: number };
export type ListResult = { objects: Array<{ key: string; size: number }>; prefixes: string[]; cursor: string | null };

export class S3 {
    private client: AwsClient;
    private base: string;

    constructor(opts: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {
        // aws4fetch has its own retry loop; disable it so backoff lives in one place.
        this.client = new AwsClient({
            accessKeyId: opts.accessKeyId,
            secretAccessKey: opts.secretAccessKey,
            region: 'auto',
            service: 's3',
            retries: 0,
        });
        this.base = `${opts.endpoint.replace(/\/+$/, '')}/${opts.bucket}`;
    }

    private url(key: string): string {
        return `${this.base}/${key}`;
    }

    private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
                const res = await this.client.fetch(url, init);
                if (res.status < 500 && res.status !== 429) return res;
                lastErr = new Error(`HTTP ${res.status}`);
                await res.arrayBuffer().catch(() => undefined); // drain before retrying
            } catch (e) {
                lastErr = e;
            }
            if (attempt < RETRIES) await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
        }
        throw new Error(`S3 request failed after ${RETRIES} attempts: ${(lastErr as Error).message}`);
    }

    async head(key: string): Promise<{ ok: boolean; etag: string | null; size: number }> {
        const res = await this.fetchWithRetry(this.url(key), { method: 'HEAD' });
        if (res.status === 200) return { ok: true, etag: res.headers.get('etag'), size: Number(res.headers.get('content-length') ?? 0) };
        if (res.status === 404) return { ok: false, etag: null, size: 0 };
        throw new Error(`HEAD ${key} → HTTP ${res.status}`);
    }

    /** Raw GET Response for streaming (the image proxy). Caller owns status handling and the body. */
    async getResponse(key: string): Promise<Response> {
        return this.fetchWithRetry(this.url(key), { method: 'GET' });
    }

    /** GET a small text/JSON object; null on 404. etag comes back verbatim (quoted) for If-Match round-trips. */
    async getText(key: string): Promise<{ text: string; etag: string | null } | null> {
        const res = await this.fetchWithRetry(this.url(key), { method: 'GET' });
        if (res.status === 404) {
            await res.arrayBuffer().catch(() => undefined);
            return null;
        }
        if (res.status !== 200) throw new Error(`GET ${key} → HTTP ${res.status}`);
        return { text: await res.text(), etag: res.headers.get('etag') };
    }

    async getBytes(key: string): Promise<{ bytes: ArrayBuffer; etag: string | null } | null> {
        const res = await this.fetchWithRetry(this.url(key), { method: 'GET' });
        if (res.status === 404) {
            await res.arrayBuffer().catch(() => undefined);
            return null;
        }
        if (res.status !== 200) throw new Error(`GET ${key} → HTTP ${res.status}`);
        return { bytes: await res.arrayBuffer(), etag: res.headers.get('etag') };
    }

    /** PUT with optional conditional headers. 412 (precondition failed) is returned, not thrown. */
    async put(key: string, body: BodyInit, opts: PutOptions = {}): Promise<{ status: number; etag: string | null }> {
        const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/octet-stream' };
        if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
        if (opts.ifNoneMatch) headers['if-none-match'] = opts.ifNoneMatch;
        const res = await this.fetchWithRetry(this.url(key), { method: 'PUT', body, headers });
        await res.arrayBuffer().catch(() => undefined);
        if (res.status !== 200 && res.status !== 412) throw new Error(`PUT ${key} → HTTP ${res.status}`);
        return { status: res.status, etag: res.headers.get('etag') };
    }

    /** ListObjectsV2. One page per call; `cursor` is the continuation token. */
    async list(opts: ListOptions): Promise<ListResult> {
        const params = new URLSearchParams({ 'list-type': '2', prefix: opts.prefix });
        if (opts.delimiter) params.set('delimiter', opts.delimiter);
        if (opts.cursor) params.set('continuation-token', opts.cursor);
        if (opts.maxKeys) params.set('max-keys', String(opts.maxKeys));
        const res = await this.fetchWithRetry(`${this.base}?${params}`, { method: 'GET' });
        if (res.status !== 200) throw new Error(`LIST ${opts.prefix} → HTTP ${res.status}`);
        return parseListXml(await res.text());
    }
}

function xmlDecode(v: string): string {
    return v
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/** Workers have no DOMParser; the ListObjectsV2 shape is flat enough for targeted extraction. */
export function parseListXml(xml: string): ListResult {
    const objects: Array<{ key: string; size: number }> = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const body = m[1] ?? '';
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
        if (key) objects.push({ key: xmlDecode(key), size: Number(size ?? 0) });
    }
    const prefixes: string[] = [];
    for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)) {
        if (m[1]) prefixes.push(xmlDecode(m[1]));
    }
    const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    return { objects, prefixes, cursor: token ? xmlDecode(token) : null };
}

export function s3FromEnv(env: Env): S3 {
    return new S3({
        endpoint: env.SCREENSHOTS_S3_ENDPOINT,
        bucket: env.SCREENSHOTS_S3_BUCKET,
        accessKeyId: env.SCREENSHOTS_S3_ACCESS_KEY_ID,
        secretAccessKey: env.SCREENSHOTS_S3_SECRET_ACCESS_KEY,
    });
}
