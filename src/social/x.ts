import { createHmac, randomBytes } from 'node:crypto';

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** All four or nothing — a partial set silently fails auth and looks like a network fault. */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): XCredentials | undefined {
  const apiKey = env.X_API_KEY?.trim();
  const apiSecret = env.X_API_SECRET?.trim();
  const accessToken = env.X_ACCESS_TOKEN?.trim();
  const accessSecret = env.X_ACCESS_SECRET?.trim();
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return undefined;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

/** RFC 3986, which reserves four characters `encodeURIComponent` leaves alone. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The string that actually gets signed. Exported so it can be checked against X's own
 *  published example — an unverifiable signature is one that 401s forever in silence. */
export function signatureBase(method: string, url: string, params: Record<string, string>): string {
  return [
    method.toUpperCase(),
    encode(url),
    encode(
      Object.keys(params)
        .sort()
        .map((k) => `${encode(k)}=${encode(params[k]!)}`)
        .join('&'),
    ),
  ].join('&');
}

export function sign(base: string, consumerSecret: string, tokenSecret: string): string {
  return createHmac('sha1', `${encode(consumerSecret)}&${encode(tokenSecret)}`).update(base).digest('base64');
}

/**
 * OAuth 1.0a, because posting *as an account* needs user context and app-only bearer tokens
 * cannot do it. A JSON body is not part of the signature base string — only the query and
 * the oauth_ parameters are — which is the detail that makes this short.
 */
function authorization(creds: XCredentials, method: string, url: string): string {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  params.oauth_signature = sign(
    signatureBase(method, url, params),
    creds.apiSecret,
    creds.accessSecret,
  );

  return `OAuth ${Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}="${encode(params[k]!)}"`)
    .join(', ')}`;
}

export type PostResult = { ok: true; id: string } | { ok: false; reason: string };

const ENDPOINT = 'https://api.x.com/2/tweets';

export async function postTweet(creds: XCredentials, text: string, timeoutMs = 10_000): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: authorization(creds, 'POST', ENDPOINT),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: { id?: string };
      detail?: string;
      title?: string;
    };

    if (!res.ok) {
      // 429 is the free tier's monthly post cap far more often than a rate limit, and the
      // two want completely different responses from whoever is reading the log.
      const detail = body.detail ?? body.title ?? `HTTP ${res.status}`;
      return { ok: false, reason: res.status === 429 ? `${detail} (post cap reached?)` : detail };
    }
    const id = body.data?.id;
    return id ? { ok: true, id } : { ok: false, reason: 'no tweet id in response' };
  } catch (err) {
    const e = err as Error;
    return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** X counts a URL as 23 characters however long it is, so a naive length check over-rejects. */
export const TWEET_LIMIT = 280;

export function tweetLength(text: string): number {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  const withoutUrls = urls.reduce((acc, url) => acc.replace(url, ''), text);
  return [...withoutUrls].length + urls.length * 23;
}
