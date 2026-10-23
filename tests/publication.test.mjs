import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { applyPageMetadata, createRobots, createSitemap, normalizeSiteUrl, publicPages } from '../scripts/site-meta.mjs';

const root = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');
const site = 'https://htss-co.kz/';

test('accepts one HTTPS root and rejects ambiguous publication URLs', () => {
  assert.equal(normalizeSiteUrl('https://htss-co.kz'), site);
  for (const value of ['http://htss-co.kz/', 'https://htss-co.kz/path/',
    'https://htss-co.kz/?lang=en', 'https://htss-co.kz/#about',
    'https://user:pass@htss-co.kz/', 'https://htss-co.kz:444/']) {
    assert.throws(() => normalizeSiteUrl(value));
  }
});

test('sitemap lists only real canonical pages and robots points to that sitemap', async () => {
  const sitemap = createSitemap(site);
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]),
    [site, `${site}privacy.html`]);
  assert.doesNotMatch(sitemap, /<lastmod>|<changefreq>|<priority>|#|\/en\/|\/kk\//);
  assert.equal(await read('sitemap.xml'), sitemap);
  assert.equal(await read('robots.txt'), createRobots(site));
  for (const page of publicPages) assert.match(await read(page.file), /^\uFEFF?\s*<!doctype html>/i);
});

test('metadata replacement is idempotent and keeps one canonical per page', () => {
  const source = '<head><!-- deployment-meta --></head>';
  const first = applyPageMetadata(source, site, 'privacy.html');
  const second = applyPageMetadata(first, site, 'privacy.html');
  assert.equal(first, second);
  assert.match(first, /rel="canonical" href="https:\/\/htss-co\.kz\/privacy.html"/);
  assert.equal([...first.matchAll(/rel="canonical"/g)].length, 1);
  assert.match(first, /name="twitter:image" content="https:\/\/htss-co.kz\/assets\/media\//);
  assert.throws(() => applyPageMetadata('<head></head>', site, ''), /metadata marker/);
});

test('source metadata, CNAME and sitemap agree before building', async () => {
  assert.equal((await read('CNAME')).trim(), 'htss-co.kz');
  for (const { file, route } of publicPages) {
    const source = await read(file);
    const canonical = new URL(route, site).href;
    assert.equal([...source.matchAll(/rel="canonical" href="([^"]+)"/g)].length, 1);
    assert.ok(source.includes(`rel="canonical" href="${canonical}"`));
    assert.ok(source.includes(`property="og:url" content="${canonical}"`));
  }
  assert.equal(await read('.nojekyll'), '');
});

test('old section links and all current fragment links remain valid', async () => {
  const html = await read('index.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML ids');
  for (const id of ['hero-scroller', 'about', 'philosophy', 'directions', 'services', 'contacts']) {
    assert.ok(ids.includes(id), `legacy fragment #${id} is missing`);
  }
  for (const [, id] of html.matchAll(/\bhref="#([^"]+)"/g)) assert.ok(ids.includes(id), `broken #${id}`);
});

test('static publication keeps the live FormSubmit recipient and public contacts', async () => {
  const context = vm.createContext({ window: {} });
  new vm.Script(await read('site-config.js'), { filename: fileURLToPath(new URL('site-config.js', root)) }).runInContext(context);
  const config = context.window.HTSS_CONFIG;
  assert.equal(config.delivery, 'formsubmit');
  assert.equal(config.contactEmail, 'info@htss-co.kz');
  assert.equal(config.contactPhone, '+77015919386');
  const endpoint = new URL(config.contactEndpoint);
  assert.equal(endpoint.origin, 'https://formsubmit.co');
  assert.equal(decodeURIComponent(endpoint.pathname), `/ajax/${config.contactEmail}`);
  assert.equal(endpoint.search + endpoint.hash, '');
});
