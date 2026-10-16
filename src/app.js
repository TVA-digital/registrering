'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const compression = require('compression');
const { AppError } = require('./feil');
const { validerPamelding } = require('./validering');
const { maksForBackup, stederForApi, stedForKvittering, lagCsv, csvFilnavn, oppsummering } = require('./hjelpere');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Enkel rate limiting per IP i minnet (per instans). */
function rateLimiter({ vindu = 60_000, maks = 10 } = {}) {
  const treff = new Map();
  const rydd = setInterval(() => {
    const na = Date.now();
    for (const [k, v] of treff) if (v.reset <= na) treff.delete(k);
  }, vindu);
  rydd.unref();
  return (req, res, next) => {
    const na = Date.now();
    const key = req.ip || 'ukjent';
    let t = treff.get(key);
    if (!t || t.reset <= na) {
      t = { n: 0, reset: na + vindu };
      treff.set(key, t);
    }
    if (++t.n > maks) {
      res.set('Retry-After', String(Math.ceil((t.reset - na) / 1000)));
      return res.status(429).json({ kode: 'for_mange', feil: 'For mange forsøk. Vent litt og prøv igjen.' });
    }
    next();
  };
}

function adminAuth(passord) {
  const forventet = Buffer.from(`admin:${passord}`);
  return (req, res, next) => {
    const [type, verdi] = String(req.headers.authorization || '').split(' ');
    const mottatt = type === 'Basic' && verdi ? Buffer.from(verdi, 'base64') : Buffer.alloc(0);
    const ok =
      mottatt.length === forventet.length && crypto.timingSafeEqual(mottatt, forventet);
    if (!ok) {
      res.set('WWW-Authenticate', 'Basic realm="Pamelding backup", charset="UTF-8"');
      return res.status(401).send('Innlogging kreves');
    }
    next();
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * @param {object} opts
 * @param {object} opts.storage   lagringsimplementasjon (sqlite/firestore)
 * @param {object} opts.data      innholdet i data/oppmotesteder.json
 * @param {string} [opts.adminPassord]
 * @param {object} [opts.logger]
 */
function lagApp({ storage, data, adminPassord, personvernUrl, logger = console, rateLimit = {} }) {
  const steder = data.steder;
  const stedMap = new Map(steder.map((s) => [s.id, s]));

  // Telleren caches kort, slik at listen ikke spør databasen for hver sidevisning.
  let antallCache = { tid: 0, data: new Map(), pagar: null };
  async function antallPerSted({ fersk = false } = {}) {
    if (!fersk && Date.now() - antallCache.tid < 15_000) return antallCache.data;
    if (antallCache.pagar) return antallCache.pagar;
    antallCache.pagar = storage
      .antallPerSted()
      .then((m) => {
        antallCache = { tid: Date.now(), data: m, pagar: null };
        return m;
      })
      .catch((err) => {
        antallCache.pagar = null;
        throw err;
      });
    return antallCache.pagar;
  }

  const app = express();
  app.disable('x-powered-by');
  const trustProxy = process.env.TRUST_PROXY ?? '1';
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' || trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    });
    next();
  });
  app.use(compression());

  app.get('/healthz', async (req, res) => {
    try {
      await storage.sjekk();
      res.json({ ok: true, steder: steder.length });
    } catch (err) {
      logger.error('Helsesjekk feilet:', err);
      res.status(503).json({ ok: false });
    }
  });

  app.get('/api/konfig', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ personvernUrl });
  });

  app.get('/api/oppmotesteder', async (req, res, next) => {
    try {
      let antall;
      try {
        antall = await antallPerSted();
      } catch (err) {
        // Listen skal fortsatt vises selv om tellingen feiler; kapasitet sjekkes uansett ved innsending.
        logger.error('Klarte ikke hente antall påmeldte:', err);
        antall = new Map();
      }
      res.set('Cache-Control', 'public, max-age=15');
      res.json(stederForApi(steder, antall));
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/registrering',
    rateLimiter(rateLimit),
    express.json({ limit: '10kb' }),
    async (req, res, next) => {
      try {
        // Honningkrukke: usynlig felt som bare roboter fyller ut. Svar "ok" uten å lagre.
        if (req.body && typeof req.body.nettside === 'string' && req.body.nettside.trim()) {
          logger.warn('Honningkrukke utløst, ignorerer innsending');
          return res.status(201).json({ ok: true });
        }
        const reg = validerPamelding(req.body);
        const sted = stedMap.get(reg.stedId);
        if (!sted) throw new AppError('Oppmøtestedet finnes ikke.', { status: 400, kode: 'ugyldig', felt: 'stedId' });

        const { id } = await storage.opprett(reg, { maksBackup: maksForBackup(sted), fulltTekst: sted.fulltTekst });
        antallCache.tid = 0;
        logger.info(`Ny påmelding ${id} til ${sted.id} (${sted.navn})`);
        res.status(201).json({ ok: true, sted: stedForKvittering(sted) });
      } catch (err) {
        next(err);
      }
    }
  );

  if (adminPassord) {
    const auth = adminAuth(adminPassord);

    app.get('/admin/registreringer.csv', auth, async (req, res, next) => {
      try {
        const csv = lagCsv(await storage.alle(), stedMap);
        res.set({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${csvFilnavn()}"`,
          'Cache-Control': 'no-store',
        });
        res.send(csv);
      } catch (err) {
        next(err);
      }
    });

    app.get('/admin', auth, async (req, res, next) => {
      try {
        const antall = await antallPerSted({ fersk: true });
        const { totalt, perFylke } = oppsummering(antall, stedMap);
        const rader = perFylke
          .map(({ fylke, antall: n }) => `<tr><td>${escapeHtml(fylke)}</td><td class="tall">${n}</td></tr>`)
          .join('');
        res.set('Cache-Control', 'no-store');
        res.send(`<!doctype html><html lang="nb"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Påmeldinger – backup</title>
<link rel="stylesheet" href="/admin.css"></head><body><main>
<h1>Påmeldinger i backup-løsningen</h1>
<p class="kpi"><span>${totalt}</span> påmeldte totalt</p>
<p><a class="knapp" href="/admin/registreringer.csv">Last ned alle påmeldinger (CSV)</a></p>
<table><thead><tr><th>Fylke/storby</th><th class="tall">Påmeldte</th></tr></thead>
<tbody>${rader || '<tr><td colspan="2">Ingen påmeldinger ennå</td></tr>'}</tbody></table>
<p class="liten">Tallene gjelder kun påmeldinger gjort i backup-løsningen, ikke i Aksjonsportalen.</p>
</main></body></html>`);
      } catch (err) {
        next(err);
      }
    });
  }

  // admin.html brukes på Vercel og webhotell. Node-serveren har sin egen /admin med Basic Auth.
  app.get('/admin.html', (req, res) => res.redirect(302, '/admin'));

  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ['html'],
      setHeaders(res, fil) {
        res.set('Cache-Control', fil.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
      },
    })
  );

  app.use('/api', (req, res) => res.status(404).json({ kode: 'ikke_funnet', feil: 'Fant ikke ressursen.' }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ kode: 'ugyldig', feil: 'Ugyldig forespørsel.' });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ kode: err.kode, feil: err.message, felt: err.felt });
    }
    logger.error('Uventet feil:', err);
    res.status(503).json({
      kode: 'intern_feil',
      feil: 'Noe gikk galt hos oss. Prøv igjen om litt – påmeldingen din er ikke lagret.',
    });
  });

  return app;
}

module.exports = { lagApp };
