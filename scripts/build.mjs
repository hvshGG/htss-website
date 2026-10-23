import { cp, mkdir, readFile, writeFile, access, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPageMetadata, createRobots, createSitemap, normalizeSiteUrl, publicPages } from './site-meta.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const files = ['index.html', 'privacy.html', 'favicon.svg', 'icon.png', 'social-preview.svg', 'site-config.js', '.nojekyll'];
const domain = (await readFile(path.join(root, 'CNAME'), 'utf8')).trim();
const siteUrl = normalizeSiteUrl(process.env.SITE_URL?.trim() || `https://${domain}/`);
// Prepare and validate metadata before touching the previous build output.
const pages = await Promise.all(publicPages.map(async ({ file, route }) => ({
  file, content: applyPageMetadata(await readFile(path.join(root, file), 'utf8'), siteUrl, route),
})));
const html = await readFile(path.join(root, 'index.html'), 'utf8');
if (/<script\b[^>]*src=["']https?:/i.test(html) || /\bon(?:click|submit|load)\s*=/i.test(html)) {
  throw new Error('HTML must use local scripts and external event handlers.');
}
for (const match of html.matchAll(/(?:src|href)="((?:assets\/|site-config\.js|favicon\.svg)[^"?#]*)/g)) {
  await access(path.join(root, match[1]));
}
// Clean only this checkout's generated directory; never follow an output symlink.
if (path.dirname(path.resolve(dist)) !== path.resolve(root) || path.basename(dist) !== 'dist') {
  throw new Error('Build output must stay in this project/dist.');
}
const oldOutput = await lstat(dist).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (oldOutput?.isSymbolicLink()) throw new Error('Build output must not be a symbolic link.');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(path.join(root, file), path.join(dist, file));
await cp(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });

for (const { file, content } of pages) await writeFile(path.join(dist, file), content);
await writeFile(path.join(dist, 'robots.txt'), createRobots(siteUrl));
await writeFile(path.join(dist, 'sitemap.xml'), createSitemap(siteUrl));
await writeFile(path.join(dist, 'CNAME'), `${new URL(siteUrl).hostname}\n`);
console.log(`Built dist/ for ${siteUrl}: pages, local assets, sitemap.xml, robots.txt and GitHub Pages domain.`);
