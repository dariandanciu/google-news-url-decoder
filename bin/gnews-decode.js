#!/usr/bin/env node
// Usage: gnews-decode <google news link> [more links...]   (or pipe links in, one per line)
import { decodeGoogleNewsUrls } from '../src/index.js';

let inputs = process.argv.slice(2);
if (!inputs.length && !process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    inputs = text.split(/\s+/).filter(Boolean);
}
if (!inputs.length) {
    console.error('Usage: gnews-decode <https://news.google.com/rss/articles/...> [...]');
    process.exit(2);
}
let failed = 0;
for (const r of await decodeGoogleNewsUrls(inputs)) {
    if (r.url) console.log(r.url);
    else {
        failed++;
        console.error(`FAILED ${r.input}: ${r.error}`);
    }
}
process.exit(failed ? 1 : 0);
