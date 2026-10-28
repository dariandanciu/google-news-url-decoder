// Decode Google News article links (news.google.com/rss/articles/...) to the publisher's URL.
//
// Since mid-2024 the article id is no longer a base64-encoded URL. The redirect page carries a
// signature and timestamp (data-n-a-sg / data-n-a-ts); posting those, with the id, to Google's
// internal batchexecute endpoint (rpc "Fbv4je") returns the real URL. Two requests per link.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BATCHEXECUTE = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RetryableError extends Error {}

/** The article id from any Google News article link, or the id itself. Null if it isn't one. */
export function articleIdFromUrl(input) {
    const value = String(input ?? '').trim();
    if (/^[\w-]{20,}$/.test(value)) return value;
    let u;
    try {
        u = new URL(value);
    } catch {
        return null;
    }
    if (u.hostname !== 'news.google.com') return null;
    return u.pathname.match(/\/(?:rss\/)?(?:articles|read)\/([\w-]+)/)?.[1] ?? null;
}

/** Signature and timestamp Google embeds in the article redirect page. */
export function decodeParams(html) {
    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    return sg && ts ? { sg, ts: Number(ts) } : null;
}

/** Form body for the batchexecute call. The 'X' placeholders are what Google's own page sends. */
export function batchexecuteBody(articleId, { sg, ts }) {
    const inner = JSON.stringify([
        'garturlreq',
        [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
        articleId, ts, sg,
    ]);
    return `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
}

/** Pull the publisher URL out of a batchexecute response (it starts with the )]}' guard line). */
export function parseBatchexecute(text) {
    for (const line of text.split('\n')) {
        if (!line.startsWith('[[')) continue;
        let rows;
        try {
            rows = JSON.parse(line);
        } catch {
            continue;
        }
        for (const row of rows) {
            if (row[1] === 'Fbv4je' && typeof row[2] === 'string') {
                const url = JSON.parse(row[2])?.[1];
                if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
            }
        }
    }
    return null;
}

async function fetchText(url, init, { fetch: fetchImpl = globalThis.fetch, dispatcher, retries = 4, wait = sleep, timeoutMs = 30_000 }) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            let res;
            try {
                res = await fetchImpl(url, {
                    ...init,
                    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...init.headers },
                    dispatcher,
                    redirect: 'follow',
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (err) {
                throw new RetryableError(`Network error: ${err.cause?.code ?? err.message}`);
            }
            let text;
            try {
                text = await res.text();
            } catch (err) {
                // A body that times out after the headers arrived is as retryable as a failed connect.
                throw new RetryableError(`Response read failed: ${err.cause?.code ?? err.message}`);
            }
            if (res.status === 429 || res.status === 403 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 100)}`);
            return text;
        } catch (err) {
            last = err;
            if (!(err instanceof RetryableError) || attempt === retries) break;
            await wait(Math.min(20_000, 800 * 2 ** attempt) * (0.5 + Math.random()));
        }
    }
    throw last;
}

/**
 * Decode one Google News link (or bare article id) to the publisher's URL.
 * Options: fetch (a fetch implementation), dispatcher (an undici Agent/ProxyAgent), retries, timeoutMs.
 * Throws if the input isn't a Google News article link or Google returns no URL.
 */
export async function decodeGoogleNewsUrl(input, options = {}) {
    const id = articleIdFromUrl(input);
    if (!id) throw new Error(`Not a Google News article link: ${String(input).slice(0, 100)}`);
    const page = await fetchText(`https://news.google.com/rss/articles/${id}`, { method: 'GET' }, options);
    const params = decodeParams(page);
    if (!params) throw new Error('Article page has no decoding signature (Google changed the page, or served a block page)');
    const res = await fetchText(BATCHEXECUTE, {
        method: 'POST',
        body: batchexecuteBody(id, params),
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    }, options);
    const url = parseBatchexecute(res);
    if (!url) throw new Error('Google returned no URL for this article');
    return url;
}

/**
 * Decode many links with limited concurrency. Never throws for a single bad link:
 * returns [{ input, url, error }] in input order.
 */
export async function decodeGoogleNewsUrls(inputs, { concurrency = 3, ...options } = {}) {
    const out = new Array(inputs.length);
    let next = 0;
    const worker = async () => {
        while (next < inputs.length) {
            const i = next++;
            try {
                out[i] = { input: inputs[i], url: await decodeGoogleNewsUrl(inputs[i], options), error: null };
            } catch (err) {
                out[i] = { input: inputs[i], url: null, error: err.message };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
    return out;
}

// --- RSS feeds: where the links come from -------------------------------------------------

/** Google News RSS URL for a search query, a topic (WORLD, BUSINESS, TECHNOLOGY, ...), or top stories. */
export function feedUrl({ query, topic, hl = 'en-US', gl = 'US', ceid = `${gl}:${hl.split('-')[0]}`, when } = {}) {
    const params = new URLSearchParams({ hl, gl, ceid });
    if (query) {
        params.set('q', when ? `${query} when:${when}` : query);
        return `https://news.google.com/rss/search?${params}`;
    }
    if (topic) return `https://news.google.com/rss/headlines/section/topic/${encodeURIComponent(topic)}?${params}`;
    return `https://news.google.com/rss?${params}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
        return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
const tag = (xml, name) => {
    const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    return m ? decode(m[1]) : null;
};

/** Parse Google News RSS into items. `link` is still the Google News link; decode it separately. */
export function parseFeed(xml) {
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
        const source = tag(item, 'source');
        let title = tag(item, 'title') ?? '';
        // Google appends " - Source Name" to every title.
        if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
        const pub = tag(item, 'pubDate');
        return {
            title,
            source,
            sourceUrl: item.match(/<source url="([^"]+)"/)?.[1] ?? null,
            publishedAt: pub ? new Date(pub).toISOString() : null,
            link: tag(item, 'link'),
            id: tag(item, 'guid'),
        };
    });
}

/** Fetch and parse a feed. Same options as decodeGoogleNewsUrl. */
export async function fetchFeed(feedOptions, options = {}) {
    return parseFeed(await fetchText(feedUrl(feedOptions), { method: 'GET' }, options));
}
