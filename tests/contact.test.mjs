import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createServer } from '../server.mjs';

const environment = {
  CONTACT_TO: 'contact@example.test', CONTACT_FROM: 'website@example.test',
  SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false',
  SMTP_USER: 'test-user', SMTP_PASS: 'test-password',
};
const valid = {
  name: 'Тестовый клиент', phone: '+7 (701) 123-45-67', sector: 'prom',
  consent: true, website: '', language: 'ru', message: 'Тестовый проект',
};
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + '  <url><loc>https://htss-co.kz/</loc></url>\n'
  + '  <url><loc>https://htss-co.kz/privacy.html</loc></url>\n'
  + '</urlset>\n';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htss-server-test-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Test</title>');
  await writeFile(path.join(root, 'sitemap.xml'), sitemap);
  await writeFile(path.join(root, 'CNAME'), 'htss-co.kz\n');
  await writeFile(path.join(root, 'assets', 'test.js'), '/* test asset */');
  await writeFile(path.join(root, '.env'), 'SMTP_PASS=DO_NOT_PUBLISH');
  await writeFile(path.join(root, 'server.mjs'), 'DO_NOT_PUBLISH');
  const messages = [];
  const logs = [];
  const server = createServer({
    root, env: environment,
    mailer: { sendMail: async (message) => { messages.push(message); return { accepted: [environment.CONTACT_TO] }; } },
    logger: { error: (message) => logs.push(message) },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('htss-server-test-')) {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root, origin, messages, logs,
    post: (body = valid, init = {}) => fetch(`${origin}/api/contact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body), ...init,
    }),
  };
}

test('reports success only after the configured recipient accepts the message', async (t) => {
  let complete;
  let received;
  const delivery = new Promise((resolve) => { complete = resolve; });
  const f = await fixture(t, { mailer: { sendMail: async (message) => { received = message; return delivery; } } });
  let settled = false;
  const response = f.post().then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(settled, false);
  complete({ accepted: ['contact@example.test'] });
  assert.equal((await response).status, 200);
  assert.deepEqual(await (await response).json(), { ok: true });
  assert.deepEqual(received.envelope.to, ['contact@example.test']);
  assert.equal(received.envelope.from, 'website@example.test');
  assert.match(received.text, /Тестовый клиент/u);
  assert.equal(received.disableUrlAccess, true);
  assert.equal(received.disableFileAccess, true);
});

test('does not claim success if SMTP accepts a different recipient or rejects the expected one', async (t) => {
  for (const info of [{ accepted: ['wrong@example.test'] }, { accepted: ['contact@example.test'], rejected: ['contact@example.test'] }]) {
    const f = await fixture(t, { mailer: { sendMail: async () => info } });
    const response = await f.post();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'delivery_failed');
  }
});

test('SMTP errors do not disclose credentials or applicant data in response or logs', async (t) => {
  const f = await fixture(t, { mailer: { sendMail: async () => { throw new Error('test-password Тестовый клиент'); } } });
  const response = await f.post();
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /test-password|Тестовый клиент/u);
  assert.doesNotMatch(f.logs.join('\n'), /test-password|Тестовый клиент/u);
});

test('rejects invalid phone, name, sector, consent, honeypot, language and excessive message', async (t) => {
  const f = await fixture(t, { rateLimit: { maximum: 30 } });
  for (const patch of [
    { phone: 'abc' }, { phone: '123456' }, { phone: '1234567890123456' },
    { phone: '7.701.123.45.67' }, { phone: '77+011234567' }, { phone: '+77011234567'.padEnd(31, ')') },
    { name: 'A' }, { name: 'a'.repeat(81) }, { name: 'User\nBcc: bad@example.test' }, { sector: 'unknown' },
    { consent: false }, { consent: 'true' }, { website: 'https://spam.test' },
    { language: 'other' }, { message: 'a'.repeat(2001) },
  ]) {
    const response = await f.post({ ...valid, ...patch });
    assert.equal(response.status, 422, JSON.stringify(patch));
  }
  assert.equal(f.messages.length, 0);
});

test('refuses cross-site requests, form content types and wrong methods', async (t) => {
  const f = await fixture(t);
  const origin = await f.post(valid, { headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.test' } });
  assert.equal(origin.status, 403);
  const contentType = await f.post(valid, { headers: { 'Content-Type': 'text/plain', Origin: f.origin } });
  assert.equal(contentType.status, 415);
  const method = await fetch(`${f.origin}/api/contact`);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal(f.messages.length, 0);
});

test('limits JSON body length and refuses malformed JSON', async (t) => {
  const f = await fixture(t);
  const oversized = await f.post({ ...valid, message: 'a'.repeat(9000) });
  assert.equal(oversized.status, 413);
  const invalid = await f.post(null, { body: '{broken' });
  assert.equal(invalid.status, 400);
  assert.equal(f.messages.length, 0);
});

test('cross-site and no-CORS form requests cannot consume the visitor submission quota', async (t) => {
  const f = await fixture(t, { rateLimit: { maximum: 1 } });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const crossSite = await f.post(valid, {
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.test', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
    const noCors = await f.post(valid, { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(noCors.status, 415);
  }
  assert.equal((await f.post()).status, 200);
  assert.equal(f.messages.length, 1);
  assert.equal((await f.post()).status, 429);
});

test('limits submission attempts and permits them again after the window expires', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, rateLimit: { maximum: 2, windowMs: 60_000 } });
  assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 200);
  const denied = await f.post();
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('retry-after'), '60');
  time += 60_001;
  assert.equal((await f.post()).status, 200);
  assert.equal(f.messages.length, 3);
});

test('runtime config exposes only public contacts and disables submission without SMTP', async (t) => {
  for (const [env, delivery] of [[{}, 'unconfigured'], [{ CONTACT_TO: 'contact@example.test' }, 'email']]) {
    const f = await fixture(t, { env });
    const response = await fetch(`${f.origin}/site-config.js`);
    const script = await response.text();
    assert.match(script, new RegExp(`"delivery":"${delivery}"`));
    assert.match(script, /"contactEndpoint":""/);
    assert.doesNotMatch(script, /SMTP_|test-password|test-user/);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /formsubmit\.co/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await f.post()).status, 503);
    assert.equal(f.messages.length, 0);
  }
});

test('automatic SMTP mode keeps its local endpoint and does not allow external contact connections', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/site-config.js`);
  const script = await response.text();
  assert.match(script, /"delivery":"smtp"/);
  assert.match(script, /"contactEndpoint":"\/api\/contact"/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /formsubmit\.co/);
});

test('explicit FormSubmit config encodes the recipient and never falls back to SMTP', async (t) => {
  for (const email of ['info@htss-co.kz', 'sales+plan/route?#%40@company.test']) {
    const f = await fixture(t, { env: { ...environment, CONTACT_TO: email, CONTACT_PROVIDER: 'formsubmit' } });
    const response = await fetch(`${f.origin}/site-config.js`);
    const script = await response.text();
    const config = JSON.parse(script.match(/^window\.HTSS_CONFIG = (.+);\n$/)[1]);
    assert.equal(config.delivery, 'formsubmit');
    assert.equal(config.contactEmail, email);
    assert.equal(config.contactEndpoint, `https://formsubmit.co/ajax/${encodeURIComponent(email)}`);
    const endpoint = new URL(config.contactEndpoint);
    assert.equal(endpoint.origin, 'https://formsubmit.co');
    assert.equal(endpoint.pathname, `/ajax/${encodeURIComponent(email)}`);
    assert.equal(endpoint.search, '');
    assert.equal(endpoint.hash, '');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self' https:\/\/formsubmit\.co(?:;|$)/);
    assert.doesNotMatch(script, /SMTP_|test-password|test-user/);
    assert.equal((await f.post()).status, 503);
    assert.equal(f.messages.length, 0);
  }
});

test('FormSubmit is disabled without a valid configured recipient', async (t) => {
  const f = await fixture(t, { env: { CONTACT_PROVIDER: 'formsubmit', CONTACT_TO: 'invalid' } });
  const response = await fetch(`${f.origin}/site-config.js`);
  const script = await response.text();
  assert.match(script, /"delivery":"unconfigured"/);
  assert.match(script, /"contactEndpoint":""/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /formsubmit\.co/);
  assert.equal((await f.post()).status, 503);
});

test('serves the two-page sitemap as XML for GET and HEAD', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/sitemap.xml`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const body = await response.text();
  assert.equal(body, sitemap);
  assert.deepEqual(Array.from(body.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]), [
    'https://htss-co.kz/', 'https://htss-co.kz/privacy.html',
  ]);
  const head = await fetch(`${f.origin}/sitemap.xml`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(sitemap)));
  assert.equal(await head.text(), '');
  const cname = await fetch(`${f.origin}/CNAME`);
  assert.equal(cname.status, 200);
  assert.equal(cname.headers.get('content-type'), 'text/plain; charset=utf-8');
});

test('serves public files with security headers but blocks secrets, source and traversal', async (t) => {
  const f = await fixture(t);
  const index = await fetch(f.origin);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(index.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('strict-transport-security'), null);
  for (const route of ['/.env', '/.git/config', '/server.mjs', '/package.json', '/assets/../.env', '/assets/%2e%2e/.env', '/assets/%252e%252e/.env', '/assets/%5c..%5c.env']) {
    const response = await fetch(`${f.origin}${route}`);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(await response.text(), /DO_NOT_PUBLISH/);
  }
  const head = await fetch(`${f.origin}/assets/test.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const range = await fetch(`${f.origin}/assets/test.js`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '/* t');
});

test('does not serve files through a symbolic link', async (t) => {
  const f = await fixture(t);
  const privateDirectory = path.join(f.root, 'private');
  await mkdir(privateDirectory);
  await writeFile(path.join(privateDirectory, 'secret.js'), 'DO_NOT_PUBLISH');
  try {
    // Windows directory junctions do not require Developer Mode or administrator privileges.
    await symlink(privateDirectory, path.join(f.root, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('Creating symlinks requires privileges on this Windows host.');
      return;
    }
    throw error;
  }
  assert.equal((await fetch(`${f.origin}/assets/linked/secret.js`)).status, 404);
});
