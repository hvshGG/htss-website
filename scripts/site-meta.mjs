export const publicPages = Object.freeze([
  { file: 'index.html', route: '' },
  { file: 'privacy.html', route: 'privacy.html' },
]);

export function normalizeSiteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SITE_URL must be an HTTPS root URL without a path, port, credentials, query or fragment.');
  }
  return `${url.origin}/`;
}

const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function createSitemap(siteUrl) {
  const base = normalizeSiteUrl(siteUrl);
  const entries = publicPages.map(({ route }) => `  <url><loc>${escape(new URL(route, base).href)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

export function createRobots(siteUrl) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap.xml', normalizeSiteUrl(siteUrl)).href}\n`;
}

export function applyPageMetadata(source, siteUrl, route) {
  const base = normalizeSiteUrl(siteUrl);
  const canonical = escape(new URL(route, base).href);
  const image = escape(new URL('assets/media/hero-poster-1280.webp', base).href);
  const block = [
    '<!-- site-meta:start -->',
    `  <link rel="canonical" href="${canonical}">`,
    `  <meta property="og:url" content="${canonical}">`,
    `  <meta property="og:image" content="${image}">`,
    '  <meta property="og:image:width" content="1280">',
    '  <meta property="og:image:height" content="720">',
    `  <meta name="twitter:image" content="${image}">`,
    '  <!-- site-meta:end -->',
  ].join('\n');
  const marker = /<!-- site-meta:start -->[\s\S]*?<!-- site-meta:end -->|<!-- deployment-meta -->/;
  if (!marker.test(source)) throw new Error('Missing site metadata marker in public HTML.');
  return source.replace(marker, block);
}
