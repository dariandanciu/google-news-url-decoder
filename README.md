# google-news-url-decoder

Turn Google News links like

```
https://news.google.com/rss/articles/CBMiiwFBVV95cUxOTzZaM2JE...?oc=5
```

into the publisher's real URL:

```
https://developer.nvidia.com/blog/inside-nvidia-sentry-secure-ai-agents-at-runtime/
```

Zero dependencies, Node 20+, ESM. Includes a small Google News RSS helper and a CLI.

## Why this exists

Every link in a Google News RSS feed points to `news.google.com`, not to the article. Until mid-2024 the
article id was just the URL in base64, so decoding was a one-liner. **That no longer works.** Ids still
start with `CBMi`, but what's inside is now an opaque token (it base64-decodes to `AU_yqL...`), not the URL.

What does work is what Google's own redirect page does:

1. `GET https://news.google.com/rss/articles/<id>`. The page has two attributes, `data-n-a-sg`
   (a signature) and `data-n-a-ts` (a timestamp).
2. `POST https://news.google.com/_/DotsSplashUi/data/batchexecute` with the rpc id `Fbv4je` and a
   `garturlreq` payload containing the id, timestamp and signature.
3. The response (after Google's `)]}'` guard line) contains `["garturlres","https://real-url",1]`.

That's two requests per link. This library does them with retries, backoff on 429/5xx, and a clear
error when Google serves a block page instead.

## Install

Not on npm yet. Install straight from GitHub:

```bash
npm install github:dariandanciu/google-news-url-decoder
```

## Use

```js
import { decodeGoogleNewsUrl, decodeGoogleNewsUrls, fetchFeed } from 'google-news-url-decoder';

// One link (throws on failure)
const url = await decodeGoogleNewsUrl('https://news.google.com/rss/articles/CBMi...?oc=5');

// Many links: never throws for a single bad one, keeps input order
const results = await decodeGoogleNewsUrls(links, { concurrency: 3 });
// -> [{ input, url, error }, ...]

// Get links from a search feed, then decode them
const items = await fetchFeed({ query: 'semiconductor', when: '1d' }); // also: { topic: 'TECHNOLOGY' }, {}
const decoded = await decodeGoogleNewsUrls(items.map((i) => i.link));
```

CLI:

```bash
npx github:dariandanciu/google-news-url-decoder "https://news.google.com/rss/articles/CBMi..."
```

Links can also be piped in, one per line.

### Options

Every network function takes the same options object:

| Option | Default | |
|---|---|---|
| `retries` | `4` | Retries on 429, 403, 5xx, network errors and body-read timeouts |
| `timeoutMs` | `30000` | Per request |
| `dispatcher` | none | An undici `Agent`/`ProxyAgent`, e.g. to send requests through a proxy |
| `fetch` | `globalThis.fetch` | Bring your own fetch |
| `concurrency` | `3` | `decodeGoogleNewsUrls` only |

Through a proxy:

```js
import { ProxyAgent } from 'undici';
const url = await decodeGoogleNewsUrl(link, { dispatcher: new ProxyAgent('http://user:pass@proxy:8000') });
```

The parsing pieces (`articleIdFromUrl`, `decodeParams`, `batchexecuteBody`, `parseBatchexecute`,
`feedUrl`, `parseFeed`) are exported too, if you want to do the HTTP yourself.

## Limits

- This uses an undocumented Google endpoint. It works as of October 2026 and can break whenever Google
  changes the page. If it does, the signature regex and the `garturlreq` payload are the places to look.
- Google rate-limits by IP. From a home connection, a few hundred links at concurrency 3 is fine. From
  cloud or datacenter IPs you'll see 429s sooner. Use a `dispatcher` with rotating proxies for volume.
- Some Google News items point to Google-hosted pages (YouTube, for example). Those decode to that URL.

## Need it at scale?

If you'd rather not manage proxies and rate limits, I run the same decoder inside a hosted
[Google News Scraper on Apify](https://apify.com/dariandanciu/google-news-scraper). It does search,
topics and headlines in 12 editions, returns the decoded publisher URL for every article, retries on
residential IPs when Google blocks, and doesn't charge for failed requests.

## Tests

```bash
npm test
```

The tests run against saved real responses, so they don't touch the network.

## License

MIT
