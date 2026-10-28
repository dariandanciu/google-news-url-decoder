import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    articleIdFromUrl, batchexecuteBody, decodeGoogleNewsUrl, decodeGoogleNewsUrls, decodeParams, feedUrl, parseBatchexecute, parseFeed,
} from '../src/index.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const ID = 'CBMiiwFBVV95cUxOTzZaM2JEbHNuaEZ2SmZSU29EZlA2QmthTEdJNWVScVN3VmVvYl9NNDZqb0tTcFU2S18zMHBLd2ozQXhTU1d5bGF4d2pJRENMc1Zya1lpZTRuNlQzaGVVQWh2bmtIbmNXbHI4SWM3NDhVNXlOVUZpTTdHZWc2SmRlQWc5ZEdmMTV4N3Bz';
const noWait = { wait: async () => {} };

/** A fake fetch serving the saved article page and batchexecute response. */
function fakeFetch(overrides = {}) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init });
        if (overrides[calls.length]) return overrides[calls.length]();
        return new Response(url.includes('batchexecute') ? fixture('batchexecute.txt') : fixture('article-page.html'));
    };
    return { impl, calls };
}

test('articleIdFromUrl: rss, web and read links, bare ids, rejects others', () => {
    assert.equal(articleIdFromUrl(`https://news.google.com/rss/articles/${ID}?oc=5`), ID);
    assert.equal(articleIdFromUrl(`https://news.google.com/articles/${ID}`), ID);
    assert.equal(articleIdFromUrl(`https://news.google.com/read/${ID}?hl=en-US`), ID);
    assert.equal(articleIdFromUrl(ID), ID);
    assert.equal(articleIdFromUrl('https://example.com/rss/articles/abc'), null);
    assert.equal(articleIdFromUrl('not a link'), null);
});

test('decode helpers: signature parsing, request body, response parsing', () => {
    const p = decodeParams(fixture('article-page.html'));
    assert.deepEqual(p, { sg: 'AbIaSL9mh4byNUm5CBiMrAOL2Gbw', ts: 1793082241 });
    assert.equal(decodeParams('<html></html>'), null);
    const body = decodeURIComponent(batchexecuteBody('ABC', p).slice('f.req='.length));
    const inner = JSON.parse(JSON.parse(body)[0][0][1]);
    assert.equal(inner[0], 'garturlreq');
    assert.deepEqual(inner.slice(2), ['ABC', 1793082241, 'AbIaSL9mh4byNUm5CBiMrAOL2Gbw']);
    assert.equal(parseBatchexecute(fixture('batchexecute.txt')), 'https://developer.nvidia.com/blog/inside-nvidia-sentry-secure-ai-agents-at-runtime/');
    assert.equal(parseBatchexecute(')]}\'\n\n[["wrb.fr","other",null]]'), null);
});

test('decodeGoogleNewsUrl: page GET then batchexecute POST', async () => {
    const f = fakeFetch();
    const url = await decodeGoogleNewsUrl(`https://news.google.com/rss/articles/${ID}?oc=5`, { fetch: f.impl, ...noWait });
    assert.equal(url, 'https://developer.nvidia.com/blog/inside-nvidia-sentry-secure-ai-agents-at-runtime/');
    assert.equal(f.calls[0].url, `https://news.google.com/rss/articles/${ID}`);
    assert.equal(f.calls[1].init.method, 'POST');
    assert.match(f.calls[1].init.body, /^f\.req=/);
});

test('rate limits are retried, 404s and missing signatures are not', async () => {
    const limited = fakeFetch({ 1: () => new Response('slow down', { status: 429 }) });
    assert.match(await decodeGoogleNewsUrl(ID, { fetch: limited.impl, ...noWait }), /^https:\/\/developer\.nvidia\.com/);
    assert.equal(limited.calls.length, 3);

    const gone = fakeFetch({ 1: () => new Response('no', { status: 404 }) });
    await assert.rejects(decodeGoogleNewsUrl(ID, { fetch: gone.impl, ...noWait }), /HTTP 404/);
    assert.equal(gone.calls.length, 1);

    const blank = fakeFetch({ 1: () => new Response('<html></html>') });
    await assert.rejects(decodeGoogleNewsUrl(ID, { fetch: blank.impl, ...noWait }), /no decoding signature/);
});

test('decodeGoogleNewsUrls: bad inputs become errors, order is kept', async () => {
    const f = fakeFetch();
    const out = await decodeGoogleNewsUrls([ID, 'https://example.com/x', ID], { fetch: f.impl, ...noWait });
    assert.deepEqual(out.map((r) => Boolean(r.url)), [true, false, true]);
    assert.match(out[1].error, /Not a Google News article link/);
});

test('feedUrl and parseFeed', () => {
    const s = new URL(feedUrl({ query: 'nvidia earnings', when: '7d' }));
    assert.equal(s.pathname, '/rss/search');
    assert.equal(s.searchParams.get('q'), 'nvidia earnings when:7d');
    assert.equal(s.searchParams.get('ceid'), 'US:en');
    assert.match(feedUrl({ topic: 'TECHNOLOGY', hl: 'de', gl: 'DE' }), /\/topic\/TECHNOLOGY\?hl=de&gl=DE&ceid=DE%3Ade$/);
    const items = parseFeed(fixture('search.xml'));
    assert.equal(items.length, 4);
    for (const it of items) {
        assert.ok(it.title && it.source && it.id);
        assert.ok(!it.title.endsWith(` - ${it.source}`));
        assert.match(it.link, /^https:\/\/news\.google\.com\/rss\/articles\//);
        assert.equal(articleIdFromUrl(it.link), it.id);
    }
});
