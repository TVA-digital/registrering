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

let ansvarligStorage = null;

/** Datatilgang for nødmodulen (bruker samme Supabase-klient som påmeldingene). */
async function hentAnsvarligStorage() {
  if (!ansvarligStorage) {
    const { AnsvarligStorage, supabaseKall } = require('./storage/ansvarlig');
    const storage = await hentStorage();
    if (!storage.db) throw new Error('Nødmodulen krever Supabase (STORAGE=supabase).');
    ansvarligStorage = new AnsvarligStorage(supabaseKall(storage.db));
  }
  return ansvarligStorage;
}

/** Kun for tester. */
function settAnsvarligStorage(s) {
  ansvarligStorage = s;
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

/** Nøkkel for rate limiting på noe annet enn IP (f.eks. e-post), også HMAC-et. */
function verdiNokkel(type, verdi) {
  return `${type}:${crypto.createHmac('sha256', hemmelighet('verdi')).update(String(verdi)).digest('hex').slice(0, 32)}`;
}

async function begrens(req, res, type, maks, vinduSek = 60, { storage, nokkel } = {}) {
  storage = storage || (await hentStorage());
  if (typeof storage.begrens !== 'function') return;
  let ok = true;
  try {
    ok = await storage.begrens(nokkel || ipNokkel(req, type), maks, vinduSek);
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

function cookie(navn, verdi, sti, maxAge) {
  return `${navn}=${verdi}; Path=${sti}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function settSesjon(res) {
  const utloper = String(Math.floor(Date.now() / 1000) + SESJON_SEK);
  res.setHeader('Set-Cookie', cookie(COOKIE, `${utloper}.${signer(utloper)}`, '/api/admin', SESJON_SEK));
}

function slettSesjon(res) {
  res.setHeader('Set-Cookie', cookie(COOKIE, '', '/api/admin', 0));
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

// ---------- Sesjon for ansvarlige (nødmodulen) ----------

const ANSVARLIG_COOKIE = 'pamelding_ansvarlig';
const ANSVARLIG_SESJON_SEK = 12 * 3600;

function signerAnsvarlig(verdi) {
  return crypto.createHmac('sha256', hemmelighet('ansvarlig-sesjon')).update(verdi).digest('base64url');
}

function settAnsvarligSesjon(res, epost) {
  const verdi = `${Buffer.from(epost).toString('base64url')}.${Math.floor(Date.now() / 1000) + ANSVARLIG_SESJON_SEK}`;
  res.setHeader('Set-Cookie', cookie(ANSVARLIG_COOKIE, `${verdi}.${signerAnsvarlig(verdi)}`, '/api/ansvarlig', ANSVARLIG_SESJON_SEK));
}

function slettAnsvarligSesjon(res) {
  res.setHeader('Set-Cookie', cookie(ANSVARLIG_COOKIE, '', '/api/ansvarlig', 0));
}

/** Krever gyldig sesjon og at personen fortsatt står i lista over ansvarlige. Returnerer den ansvarlige. */
async function krevAnsvarlig(req) {
  const ikkeInnlogget = () => new AppError('Du må logge inn.', { status: 401, kode: 'ikke_innlogget' });
  const [e, utloper, sig] = lesCookie(req, ANSVARLIG_COOKIE).split('.');
  if (!e || !utloper || !sig || !likt(sig, signerAnsvarlig(`${e}.${utloper}`)) || Number(utloper) < Date.now() / 1000) {
    throw ikkeInnlogget();
  }
  const ansvarlig = await (await hentAnsvarligStorage()).hentAnsvarlig(Buffer.from(e, 'base64url').toString());
  if (!ansvarlig) throw ikkeInnlogget();
  return ansvarlig;
}

/** HMAC av engangskoden – selve koden lagres aldri. */
function kodeHash(epost, kode) {
  return crypto.createHmac('sha256', hemmelighet('engangskode')).update(`${epost}:${kode}`).digest('hex');
}

module.exports = {
  steder, stedMap, hentStorage, settStorage, hentAnsvarligStorage, settAnsvarligStorage,
  handler, lesJson, begrens, verdiNokkel,
  adminPassord, likt, settSesjon, slettSesjon, krevAdmin,
  settAnsvarligSesjon, slettAnsvarligSesjon, krevAnsvarlig, kodeHash,
};
