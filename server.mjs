import http from 'node:http';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 8 * 1024;
const SECTORS = new Map([
  ['prom', 'Промышленное строительство'],
  ['comm', 'Коммерческая недвижимость'],
  ['log', 'Логистика'],
  ['eng', 'Инженерные системы'],
  ['other', 'Другое'],
]);
const PUBLIC_FILES = new Set([
  'index.html', 'site-config.js', 'favicon.svg', 'icon.png', 'robots.txt', 'sitemap.xml',
  'privacy.html', 'social-preview.svg', 'CNAME',
]);
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.avif', 'image/avif'], ['.ico', 'image/x-icon'], ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.txt', 'text/plain; charset=utf-8'], ['.xml', 'application/xml; charset=utf-8'],
]);
const EMAIL = /^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/u;

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}

function settings(env) {
  const email = (env.CONTACT_TO || '').trim();
  const from = (env.CONTACT_FROM || '').trim();
  const secure = env.SMTP_SECURE === 'true';
  const port = Number(env.SMTP_PORT || (secure ? 465 : 587));
  const formSubmitReady = env.CONTACT_PROVIDER === 'formsubmit' && validEmail(email);
  const smtpReady = Boolean(
    env.CONTACT_PROVIDER !== 'formsubmit' && validEmail(email) && validEmail(from)
    && env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS
    && Number.isInteger(port) && port > 0 && port <= 65535
    && ['true', 'false', undefined, ''].includes(env.SMTP_SECURE),
  );
  let origin = '';
  if (env.PUBLIC_ORIGIN) {
    const value = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password
      || value.pathname !== '/' || value.search || value.hash) {
      throw new Error('PUBLIC_ORIGIN must be an http(s) origin without a path.');
    }
    origin = value.origin;
  }
  return {
    email: validEmail(email) ? email : '', from, smtpReady, formSubmitReady, origin,
    trustProxy: env.TRUST_PROXY === 'true',
    smtp: {
      host: env.SMTP_HOST, port, secure, requireTLS: !secure,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
      logger: false, debug: false,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    },
  };
}

function securityHeaders(res, config) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "media-src 'self'",
    config.formSubmitReady ? "connect-src 'self' https://formsubmit.co" : "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));
  if (config.origin.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function failure(status, code) {
  return Object.assign(new Error(code), { status, code });
}

async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    req.resume();
    throw failure(413, 'body_too_large');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        chunks.length = 0;
        reject(failure(413, 'body_too_large'));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.once('aborted', () => reject(failure(400, 'invalid_body')));
    req.once('error', () => reject(failure(400, 'invalid_body')));
  });
}

function validate(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const { name, phone, sector, consent, language = 'ru', website = '', message = '' } = value;
  if (typeof name !== 'string' || typeof phone !== 'string' || typeof message !== 'string'
    || typeof website !== 'string' || consent !== true || website.trim() !== ''
    || !['ru', 'kk', 'en'].includes(language) || !SECTORS.has(sector)) return null;
  const cleanName = name.trim();
  const cleanPhone = phone.trim();
  const digits = cleanPhone.replace(/\D/g, '');
  if (cleanName.length < 2 || cleanName.length > 80 || /[\u0000-\u001f\u007f]/u.test(cleanName)
    || cleanPhone.length > 30 || !/^\+?[\d ()-]+$/u.test(cleanPhone)
    || digits.length < 7 || digits.length > 15 || message.length > 2000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)
    || website.length > 200) return null;
  return { name: cleanName, phone: cleanPhone, sector, language, message: message.trim() };
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function publicFile(root, route) {
  if (route === '/') route = '/index.html';
  const relative = route.slice(1);
  const parts = relative.split('/');
  if (parts.some((part) => !part || part.startsWith('.') || /[\\\u0000:%]/u.test(part))) return null;
  if (!PUBLIC_FILES.has(relative) && !(relative.startsWith('assets/')
    && TYPES.has(path.extname(relative).toLowerCase()))) return null;
  const candidate = path.resolve(root, ...parts);
  if (!within(root, candidate)) return null;
  try {
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return null;
    }
    const [resolvedRoot, resolvedFile, stat] = await Promise.all([
      realpath(root), realpath(candidate), lstat(candidate),
    ]);
    if (!within(resolvedRoot, resolvedFile) || !stat.isFile()) return null;
    return { filename: candidate, stat };
  } catch {
    return null;
  }
}

/** A portable HTTP server. Inject mailer.sendMail in tests; real SMTP is loaded only on submission. */
export function createServer(options = {}) {
  const env = options.env || process.env;
  const config = settings(env);
  const cwd = process.cwd();
  const root = path.resolve(options.root || env.PUBLIC_DIR
    || (existsSync(path.join(cwd, 'dist', 'index.html')) ? path.join(cwd, 'dist') : cwd));
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const windowMs = options.rateLimit?.windowMs || 10 * 60 * 1000;
  const maximum = options.rateLimit?.maximum || 5;
  const maxBuckets = options.rateLimit?.maxBuckets || 10_000;
  const buckets = new Map();
  let transport;

  function rateLimit(req) {
    const forwarded = config.trustProxy && req.headers['x-forwarded-for'];
    const key = forwarded ? String(forwarded).split(',').at(-1).trim() : req.socket.remoteAddress || 'unknown';
    const time = now();
    const previous = buckets.get(key);
    if (previous && previous.until > time) {
      if (previous.count >= maximum) return Math.ceil((previous.until - time) / 1000);
      previous.count += 1;
      return 0;
    }
    if (buckets.size >= maxBuckets) {
      for (const [address, bucket] of buckets) if (bucket.until <= time) buckets.delete(address);
      if (buckets.size >= maxBuckets) return Math.ceil(windowMs / 1000);
    }
    buckets.set(key, { count: 1, until: time + windowMs });
    return 0;
  }

  async function submit(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { ok: false, code: 'method' });
    }
    let expectedOrigin;
    try {
      expectedOrigin = config.origin || new URL(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`).origin;
    } catch {
      return json(res, 400, { ok: false, code: 'origin' });
    }
    if ((req.headers.origin && req.headers.origin !== expectedOrigin)
      || req.headers['sec-fetch-site'] === 'cross-site') {
      return json(res, 403, { ok: false, code: 'origin' });
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
      return json(res, 415, { ok: false, code: 'content_type' });
    }
    const retry = rateLimit(req);
    if (retry) {
      res.setHeader('Retry-After', retry);
      return json(res, 429, { ok: false, code: 'rate_limited' });
    }
    if (!config.smtpReady) return json(res, 503, { ok: false, code: 'unavailable' });
    let request;
    try {
      request = JSON.parse(await readBody(req));
    } catch (error) {
      return json(res, error.status || 400, { ok: false, code: error.code || 'invalid_json' });
    }
    const input = validate(request);
    if (!input) return json(res, 422, { ok: false, code: 'validation' });
    try {
      if (!transport) {
        transport = options.mailer || (await import('nodemailer')).default.createTransport(config.smtp);
      }
      const info = await transport.sendMail({
        from: { name: 'HTSS — сайт', address: config.from }, to: config.email,
        envelope: { from: config.from, to: [config.email] },
        subject: '[HTSS] Новая заявка с сайта',
        text: [
          'Заявка с сайта HTSS', '', `Имя: ${input.name}`, `Телефон: ${input.phone}`,
          `Направление: ${SECTORS.get(input.sector)}`, `Язык сайта: ${input.language}`,
          `Время (UTC): ${new Date(now()).toISOString()}`, 'Согласие на обработку данных: получено', '',
          `Сообщение: ${input.message || 'Не указано'}`,
        ].join('\n'),
        disableFileAccess: true, disableUrlAccess: true,
      });
      const addressOf = (item) => String(typeof item === 'string' ? item : item?.address || '').toLowerCase();
      const accepted = Array.isArray(info?.accepted) && info.accepted.some((item) => addressOf(item) === config.email.toLowerCase());
      const rejected = Array.isArray(info?.rejected) && info.rejected.some((item) => addressOf(item) === config.email.toLowerCase());
      if (!accepted || rejected) throw new Error('recipient_not_accepted');
      return json(res, 200, { ok: true });
    } catch {
      // Never log SMTP exceptions: they can contain credentials and customer data.
      logger.error('Contact delivery failed. Check SMTP settings and mail provider status.');
      return json(res, 502, { ok: false, code: 'delivery_failed' });
    }
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res, config);
    try {
      let route;
      try {
        if (!req.url.startsWith('/')) throw new Error('invalid_path');
        route = decodeURIComponent(req.url.split('?')[0]);
      } catch {
        return json(res, 400, { ok: false, code: 'invalid_path' });
      }
      if (route === '/api/contact') return await submit(req, res);
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, 405, { ok: false, code: 'method' });
      }
      if (route === '/site-config.js') {
        const publicConfig = {
          contactEndpoint: config.formSubmitReady
            ? `https://formsubmit.co/ajax/${encodeURIComponent(config.email)}`
            : config.smtpReady ? '/api/contact' : '',
          contactEmail: config.email,
          contactPhone: '+77015919386',
          delivery: config.formSubmitReady ? 'formsubmit'
            : config.smtpReady ? 'smtp' : config.email ? 'email' : 'unconfigured',
        };
        const body = `window.HTSS_CONFIG = ${JSON.stringify(publicConfig).replace(/</g, '\\u003c')};\n`;
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      const file = await publicFile(root, route);
      if (!file) return json(res, 404, { ok: false, code: 'not_found' });
      const extension = path.extname(file.filename).toLowerCase();
      res.setHeader('Content-Type', path.basename(file.filename) === 'CNAME'
        ? 'text/plain; charset=utf-8' : TYPES.get(extension) || 'application/octet-stream');
      res.setHeader('Cache-Control', route.startsWith('/assets/')
        ? 'public, max-age=3600, must-revalidate' : 'no-cache');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range;
      let start = 0;
      let end = file.stat.size - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          if (!match[1]) start = Math.max(0, file.stat.size - Number(match[2]));
          else {
            start = Number(match[1]);
            if (match[2]) end = Math.min(Number(match[2]), end);
          }
        }
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start)
          || !Number.isSafeInteger(end) || start > end || start >= file.stat.size) {
          res.setHeader('Content-Range', `bytes */${file.stat.size}`);
          return res.writeHead(416).end();
        }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.stat.size}`);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      res.writeHead(status);
      if (req.method === 'HEAD' || file.stat.size === 0) return res.end();
      await pipeline(createReadStream(file.filename, { start, end }), res);
    } catch {
      if (!res.headersSent) json(res, 500, { ok: false, code: 'server_error' });
      else res.destroy();
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on('close', () => transport?.close?.());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createServer(process.argv.includes('--source')
    ? { root: fileURLToPath(new URL('./', import.meta.url)) } : {});
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`HTSS listening on port ${port}.`);
    const config = settings(process.env);
    if (config.formSubmitReady) console.log('Contact provider: FormSubmit.');
    else if (!config.smtpReady) console.log('SMTP is not configured. The site will offer a phone call or an email draft.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}
