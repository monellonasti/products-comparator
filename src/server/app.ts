// Fastify application: security plugins, session loading, CSRF guard, API routes, SPA static files.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { config, isProduction } from '../config.ts';
import { HttpError, loadSessionUser } from './auth.ts';
import { ImportRequestError } from '../imports/service.ts';
import { AssociationError } from '../domain/associations.ts';
import { ImageInputError } from '../vision/preprocess.ts';
import { metrics } from './metrics.ts';
import { authRoutes } from './routes/auth.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { searchRoutes } from './routes/search.ts';
import { supplierRoutes } from './routes/suppliers.ts';
import { importRoutes } from './routes/imports.ts';
import { reviewRoutes } from './routes/reviews.ts';
import { adminRoutes } from './routes/admin.ts';
import { healthRoutes } from './routes/health.ts';
import { changeRoutes } from './routes/changes.ts';

// Validation messages shown to users (details of a 400) in Italian, like the rest of the interface.
z.config(z.locales.it());

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web');

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: config.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] },
    trustProxy: isProduction,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(multipart, {
    limits: { fileSize: Math.max(config.UPLOAD_MAX_IMPORT_BYTES, config.UPLOAD_MAX_IMAGE_BYTES), files: 1, fields: 20, fieldSize: 64 * 1024 },
  });
  // Limits are per authenticated user (an office behind one NAT shares a single IP), per IP otherwise.
  await app.register(rateLimit, { global: false, keyGenerator: (request) => request.user?.id ?? request.ip });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = null;
    const method = request.method;
    // Every unsafe method is checked, whatever the path: the router decodes percent-escapes ("/%61pi/…"
    // reaches the /api routes), so a prefix test on the raw URL could be bypassed.
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      // CSRF: cross-site forms cannot set custom headers; cross-origin fetch would need CORS (not enabled).
      if (request.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Richiesta non valida (CSRF)', 'csrf');
      const origin = request.headers.origin;
      if (origin && origin !== config.PUBLIC_ORIGIN && origin !== `${request.protocol}://${request.headers.host}`) {
        throw new HttpError(403, 'Origine non consentita', 'csrf');
      }
    }
    if (!(request.routeOptions.url ?? request.url).startsWith('/api/')) return;
    request.user = await loadSessionUser(request);
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    if (route.startsWith('/api/')) metrics.observe(`http_ms{route="${route}",method="${request.method}"}`, reply.elapsedTime);
    if (reply.statusCode >= 500) metrics.inc('http_5xx_total');
  });

  app.setErrorHandler((err: any, request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ImportRequestError || err instanceof AssociationError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ImageInputError) return reply.status(422).send({ error: err.message, code: 'invalid_image' });
    if (err instanceof ZodError) {
      // A malformed id in the URL (/prodotti/abc) is a resource that does not exist, not a form error.
      const params = (request.params ?? {}) as Record<string, unknown>;
      if (err.issues.every((i) => i.path.length === 1 && typeof i.path[0] === 'string' && i.path[0] in params)) {
        return reply.status(404).send({ error: 'Risorsa non trovata' });
      }
      return reply.status(400).send({ error: 'Dati non validi', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.statusCode === 413) return reply.status(413).send({ error: 'File troppo grande' });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'Troppi tentativi: riprova tra poco' });
    // Constraint violations caused by the request (a reference to a missing record, a duplicate) are client
    // errors: answering 500 would also trigger the server-error alarms.
    if (err.code === '23503') return reply.status(400).send({ error: 'Riferimento a un elemento inesistente o rimosso' });
    if (err.code === '23505') return reply.status(409).send({ error: 'Elemento già esistente o operazione già in corso' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Errore interno. Riprova; se persiste contatta l’amministratore.' });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(catalogRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api' });
  await app.register(supplierRoutes, { prefix: '/api' });
  await app.register(importRoutes, { prefix: '/api' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(changeRoutes, { prefix: '/api' });

  if (existsSync(WEB_DIST)) {
    // Files are resolved at request time (a rebuilt bundle is served without restart). Hashed assets are
    // immutable; index.html must always be revalidated so it never points to deleted bundles.
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.header('cache-control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0];
      // API, non-GET and file-like paths (e.g. an old /assets/x.js) get a real 404, never the SPA HTML.
      if (path.startsWith('/api/') || request.method !== 'GET' || /\.[a-z0-9]{1,8}$/i.test(path)) {
        return reply.status(404).send({ error: 'Risorsa non trovata' });
      }
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'Risorsa non trovata' }));
  }
  return app;
}
