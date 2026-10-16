'use strict';

// Tester Vercel-funksjonene i api/ med SQLite i minnet i stedet for Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'et-langt-testpassord';
process.env.STORAGE = 'sqlite';

const { SqliteStorage } = require('../src/storage/sqlite');
const vercel = require('../src/vercel');

const kall = {
  steder: require('../api/oppmotesteder'),
  registrering: require('../api/registrering'),
  konfig: require('../api/konfig'),
  logginn: require('../api/admin/logginn'),
  loggut: require('../api/admin/loggut'),
  oversikt: require('../api/admin/oversikt'),
  eksport: require('../api/admin/eksport'),
};

/** Minimal etterligning av Vercels req/res. */
async function kjor(fn, { method = 'GET', body, headers = {}, ip = '10.0.0.1' } = {}) {
  const req = {
    method,
    headers: { 'x-real-ip': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body,
  };
  const res = {
    statusCode: 200, hoder: {}, data: undefined,
    setHeader(k, v) { this.hoder[k.toLowerCase()] = v; },
    getHeader(k) { return this.hoder[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.data = d; return this; },
    send(d) { this.data = d; return this; },
  };
  await fn(req, res);
  return res;
}

async function medDb(fn) {
  const storage = new SqliteStorage({ fil: ':memory:' });
  await storage.init();
  vercel.settStorage(storage);
  try { await fn(storage); } finally { vercel.settStorage(null); await storage.lukk(); }
}

const BRAANAS = '66def8b02e9b604e331d8e6a';
const person = (epost, stedId = BRAANAS) => ({
  fornavn: 'Kari', etternavn: 'Nordmann', epost, telefon: '41234567', fodselsar: '1985', samtykke: true, stedId,
});

test('oppmøtesteder og konfig', () => medDb(async () => {
  const r = await kjor(kall.steder);
  assert.equal(r.statusCode, 200);
  assert.ok(r.data.length > 1000);
  assert.equal(r.data.find((s) => s.id === BRAANAS).tid, '18.10.2026, kl. 15:30');
  assert.match(r.hoder['cdn-cache-control'], /s-maxage=15/);
  assert.equal((await kjor(kall.konfig)).data.personvernUrl, 'https://www.tvaksjonen.no/personvern');
  assert.equal((await kjor(kall.steder, { method: 'POST' })).statusCode, 405);
}));

test('påmelding: ok, duplikat, ugyldig, feil content-type', () => medDb(async () => {
  let r = await kjor(kall.registrering, { method: 'POST', body: person('kari@example.no') });
  assert.equal(r.statusCode, 201);
  assert.equal(r.data.sted.navn, 'Brånås skole');

  r = await kjor(kall.registrering, { method: 'POST', body: person('KARI@example.no') });
  assert.equal(r.statusCode, 409);
  assert.equal(r.data.kode, 'epost_brukt');

  r = await kjor(kall.registrering, { method: 'POST', body: { ...person('ny@example.no'), fodselsar: '2013' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.data.felt, 'fodselsar');

  r = await kjor(kall.registrering, { method: 'POST', body: '{"ikke json', ip: '10.0.0.2' });
  assert.equal(r.statusCode, 400);

  r = await kjor(kall.registrering, { method: 'POST', body: person('x@example.no'), headers: { 'content-type': 'text/plain' }, ip: '10.0.0.3' });
  assert.equal(r.statusCode, 415);
}));

test('rate limiting per IP', () => medDb(async () => {
  const statuser = [];
  for (let i = 0; i < 11; i++) {
    statuser.push((await kjor(kall.registrering, { method: 'POST', body: person(`p${i}@example.no`), ip: '10.9.9.9' })).statusCode);
  }
  assert.deepEqual(statuser.slice(0, 10), Array(10).fill(201));
  assert.equal(statuser[10], 429);
  // En annen IP slipper fortsatt til
  assert.equal((await kjor(kall.registrering, { method: 'POST', body: person('annen@example.no'), ip: '10.1.1.1' })).statusCode, 201);
}));

test('admin: innlogging, oversikt, eksport og utlogging', () => medDb(async () => {
  assert.equal((await kjor(kall.oversikt)).statusCode, 401);
  assert.equal((await kjor(kall.logginn, { method: 'POST', body: { passord: 'feil' } })).statusCode, 401);

  await kjor(kall.registrering, { method: 'POST', body: person('eksport@example.no') });

  const inn = await kjor(kall.logginn, { method: 'POST', body: { passord: 'et-langt-testpassord' } });
  assert.equal(inn.statusCode, 200);
  const cookie = inn.hoder['set-cookie'];
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const headers = { cookie: cookie.split(';')[0] };

  const ov = await kjor(kall.oversikt, { headers });
  assert.equal(ov.statusCode, 200);
  assert.deepEqual(ov.data.perFylke, [{ fylke: 'Akershus', antall: 1 }]);

  const csv = await kjor(kall.eksport, { headers });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.hoder['content-type'], /text\/csv/);
  assert.match(csv.data, /Kari;Nordmann;eksport@example\.no;41234567;1985;Akershus;Lillestrøm;Brånås skole/);

  // Forfalsket eller utløpt cookie avvises
  const [verdi] = headers.cookie.split('=')[1].split('.');
  assert.equal((await kjor(kall.oversikt, { headers: { cookie: `pamelding_admin=${verdi}.feil` } })).statusCode, 401);
  assert.equal((await kjor(kall.oversikt, { headers: { cookie: 'pamelding_admin=1.abc' } })).statusCode, 401);

  const ut = await kjor(kall.loggut, { method: 'POST' });
  assert.match(ut.hoder['set-cookie'], /Max-Age=0/);
}));

test('admin er stengt uten gyldig ADMIN_PASSWORD', () => medDb(async () => {
  const lagret = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'kort';
  try {
    const r = await kjor(kall.logginn, { method: 'POST', body: { passord: 'kort' } });
    assert.equal(r.statusCode, 503);
    assert.equal(r.data.kode, 'ikke_konfigurert');
  } finally {
    process.env.ADMIN_PASSWORD = lagret;
  }
}));
