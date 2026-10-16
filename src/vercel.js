'use strict';

/**
 * Felles oppsett for Vercel-funksjonene i api/: lagring, feilhåndtering, rate limiting og admin-sesjon.
 */

const crypto = require('node:crypto');
const { AppError } = require('./feil');
const data = require('../data/oppmotesteder.json');

const steder = data.steder;
const stedMap = new Map(steder.map((s) => [s.id, s]));

// ---------- Lagring ----------

let storagePromise = null;

function hentStorage() {
  if (!storagePromise) {
    let storage;
    if ((process.env.STORAGE || 'supabase') === 'supabase') {
      const { SupabaseStorage } = require('./storage/supabase');
      storage = new SupabaseStorage({ url: process.env.SUPABASE_URL, nokkel: process.env.SUPABASE_SERVICE_ROLE_KEY });
    } else {
      storage = require('./storage').lagStorage(process.env);
    }
    storagePromise = storage.init().then(() => storage);
    storagePromise.catch(() => { storagePromise = null; });
  }
  return storagePromise;
}

/** Kun for tester: bruk en annen lagring. */
function settStorage(storage) {
  storagePromise = storage ? Promise.resolve(storage) : null;
}

// ---------- Forespørsler og svar ----------

function sikkerhetsHoder(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * Pakker en handler: metode-sjekk, sikkerhetshoder og ensartede feilsvar.
 * @param {string[]} metoder tillatte HTTP-metoder
 */
function handler(metoder, fn) {
  return async (req, res) => {
    sikkerhetsHoder(res);
    try {
      if (!metoder.includes(req.method)) {
        res.setHeader('Allow', metoder.join(', '));
        throw new AppError('Metoden er ikke tillatt.', { status: 405, kode: 'ugyldig' });
      }
      await fn(req, res);
    } catch (err) {
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
      if (err instanceof AppError) {
        const body = { kode: err.kode, feil: err.message };
        if (err.felt) body.felt = err.felt;
        res.status(err.status).json(body);
        return;
      }
      console.error('Uventet feil:', err);
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({
        kode: 'intern_feil',
        feil: 'Noe gikk galt hos oss. Prøv igjen om litt – påmeldingen din er ikke lagret.',
      });
    }
  };
}

/** Leser JSON-body. Krever Content-Type: application/json (hindrer enkle CSRF-skjema). */
function lesJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new AppError('Forventet JSON.', { status: 415, kode: 'ugyldig' });
  }
  let body = req.body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    if (body.length > 10_240) throw new AppError('Ugyldig forespørsel.', { status: 400, kode: 'ugyldig' });
    try {
      body = JSON.parse(String(body));
    } catch {
      throw new AppError('Ugyldig forespørsel.', { status: 400, kode: 'ugyldig' });
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Ugyldig forespørsel.', { status: 400, kode: 'ugyldig' });
  }
  return body;
}

// ---------- Rate limiting ----------

function hemmelighet(formal) {
  const grunnlag = `${process.env.ADMIN_PASSWORD || ''}|${process.env.SUPABASE_SERVICE_ROLE_KEY || ''}`;
  return crypto.createHmac('sha256', grunnlag).update(formal).digest();
}

/** IP-adressen lagres aldri i klartekst – bare som HMAC, og bare i én time. */
function ipNokkel(req, type) {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'ukjent')
    .split(',')[0]
    .trim();
  return `${type}:${crypto.createHmac('sha256', hemmelighet('ip')).update(ip).digest('hex').slice(0, 32)}`;
}

async function begrens(req, res, type, maks, vinduSek = 60) {
  const storage = await hentStorage();
  if (typeof storage.begrens !== 'function') return;
  let ok = true;
  try {
    ok = await storage.begrens(ipNokkel(req, type), maks, vinduSek);
  } catch (err) {
    // Feiler åpent: en treg teller skal ikke stoppe ekte påmeldinger.
    console.error('Rate limiting feilet:', err);
  }
  if (!ok) {
    res.setHeader('Retry-After', String(vinduSek));
    throw new AppError('For mange forsøk. Vent litt og prøv igjen.', { status: 429, kode: 'for_mange' });
  }
}

// ---------- Admin-sesjon ----------

const COOKIE = 'pamelding_admin';
const SESJON_SEK = 3600;

function adminPassord() {
  const p = process.env.ADMIN_PASSWORD || '';
  if (p.length < 12) {
    throw new AppError('Admin er ikke satt opp. Sett ADMIN_PASSWORD (minst 12 tegn) i Vercel.', {
      status: 503,
      kode: 'ikke_konfigurert',
    });
  }
  return p;
}

function signer(verdi) {
  return crypto.createHmac('sha256', hemmelighet('admin-sesjon')).update(verdi).digest('base64url');
}

function likt(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function settSesjon(res) {
  const utloper = String(Math.floor(Date.now() / 1000) + SESJON_SEK);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${utloper}.${signer(utloper)}; Path=/api/admin; Max-Age=${SESJON_SEK}; HttpOnly; Secure; SameSite=Strict`);
}

function slettSesjon(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

function lesCookie(req, navn) {
  for (const del of String(req.headers.cookie || '').split(';')) {
    const i = del.indexOf('=');
    if (i > 0 && del.slice(0, i).trim() === navn) return del.slice(i + 1).trim();
  }
  return '';
}

function krevAdmin(req) {
  adminPassord();
  const [utloper, sig] = lesCookie(req, COOKIE).split('.');
  const gyldig = utloper && sig && likt(sig, signer(utloper)) && Number(utloper) > Date.now() / 1000;
  if (!gyldig) throw new AppError('Du må logge inn.', { status: 401, kode: 'ikke_innlogget' });
}

module.exports = {
  steder, stedMap, hentStorage, settStorage, handler, lesJson, begrens,
  adminPassord, likt, settSesjon, slettSesjon, krevAdmin,
};
