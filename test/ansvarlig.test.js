'use strict';

// Nødmodulen: engangskode på e-post, tilgangsstyring og inn-/utsjekk – mot ekte Postgres (PGlite).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'et-langt-testpassord';

const { nyDb, pgliteKall } = require('./hjelp-pglite');
const { AnsvarligStorage } = require('../src/storage/ansvarlig');
const vercel = require('../src/vercel');
const { settEpostSender } = require('../src/epost');
const { stederForAnsvarlig, harTilgang } = require('../src/tilgang');

const api = {
  kode: require('../api/ansvarlig/kode'),
  logginn: require('../api/ansvarlig/logginn'),
  loggut: require('../api/ansvarlig/loggut'),
  meg: require('../api/ansvarlig/meg'),
  liste: require('../api/ansvarlig/bossebaerere'),
  status: require('../api/ansvarlig/status'),
};

// To ekte steder fra data/oppmotesteder.json i hver sin kommune
const STED_A = vercel.steder.find((s) => s.kommune === 'Lillestrøm');
const STED_B = vercel.steder.find((s) => s.kommune === 'Loppa');

async function kjor(fn, { method = 'GET', body, query, cookie, ip = '10.0.0.1' } = {}) {
  const req = {
    method, query: query || {}, body,
    headers: { 'x-real-ip': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
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

async function oppsett() {
  const db = await nyDb();
  await db.query(`INSERT INTO ansvarlige (epost, navn, tilganger) VALUES
    ('sted@example.no', 'Siri Sted', $1), ('kommune@example.no', 'Kari Kommune', $2), ('nasjonal@tvaksjonen.no', 'Nora', '{nasjonal}')`,
  [[`sted:${STED_A.id}`], [`kommune:${STED_B.fylke}/${STED_B.kommune}`]]);
  await db.query(`INSERT INTO bossebaerere_import (ekstern_id, fornavn, etternavn, epost, telefon, sted_id) VALUES
    ('ap1', 'Anne', 'Aas', 'anne@x.no', '41111111', $1), ('ap2', 'Bjørn', 'Berg', 'b@x.no', '42222222', $2)`, [STED_A.id, STED_B.id]);
  const { rows } = await db.query(`INSERT INTO registreringer (fornavn, etternavn, epost, telefon, fodselsar, sted_id)
    VALUES ('Cecilie', 'Backup', 'c@x.no', '43333333', 1990, $1) RETURNING id`, [STED_A.id]);
  const storage = new AnsvarligStorage(pgliteKall(db));
  vercel.settAnsvarligStorage(storage);
  const sendt = [];
  settEpostSender(async (m) => { sendt.push(m); });
  return { db, sendt, backupId: rows[0].id };
}

async function loggInn(epost, sendt, ip) {
  await kjor(api.kode, { method: 'POST', body: { epost }, ip });
  const kode = sendt.filter((m) => m.epost === epost).at(-1).kode;
  const res = await kjor(api.logginn, { method: 'POST', body: { epost, kode }, ip });
  assert.equal(res.statusCode, 200);
  return res.hoder['set-cookie'].split(';')[0];
}

test('tilgangsregler', () => {
  assert.ok(harTilgang([`sted:${STED_A.id}`], STED_A));
  assert.ok(!harTilgang([`sted:${STED_A.id}`], STED_B));
  assert.ok(harTilgang([`kommune:${STED_B.kommune}`], STED_B));
  assert.ok(!harTilgang([`kommune:Feil fylke/${STED_B.kommune}`], STED_B));
  assert.ok(harTilgang([`fylke:${STED_A.fylke.toUpperCase()}`], STED_A));
  assert.equal(stederForAnsvarlig(['nasjonal'], vercel.steder).length, vercel.steder.length);
  assert.equal(stederForAnsvarlig([], vercel.steder).length, 0);
});

test('engangskode: ukjent e-post avsløres ikke, feil kode avvises, koden kan bare brukes én gang', async () => {
  const { db, sendt } = await oppsett();
  try {
    const ukjent = await kjor(api.kode, { method: 'POST', body: { epost: 'ukjent@example.no' } });
    const kjent = await kjor(api.kode, { method: 'POST', body: { epost: 'Sted@Example.no' } });
    assert.equal(ukjent.statusCode, 200);
    assert.deepEqual(ukjent.data, kjent.data, 'samme svar for kjent og ukjent adresse');
    assert.equal(sendt.length, 1);
    assert.equal(sendt[0].epost, 'sted@example.no');
    assert.match(sendt[0].kode, /^\d{6}$/);

    const feil = String((Number(sendt[0].kode) + 1) % 1_000_000).padStart(6, '0');
    assert.equal((await kjor(api.logginn, { method: 'POST', body: { epost: 'sted@example.no', kode: feil } })).statusCode, 401);
    const ok = await kjor(api.logginn, { method: 'POST', body: { epost: 'sted@example.no', kode: sendt[0].kode } });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.hoder['set-cookie'], /pamelding_ansvarlig=.*Path=\/api\/ansvarlig.*HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await kjor(api.logginn, { method: 'POST', body: { epost: 'sted@example.no', kode: sendt[0].kode } })).statusCode, 401,
      'brukt kode virker ikke igjen');

    // Koden lagres aldri i klartekst
    const { rows } = await db.query('SELECT kode_hash FROM engangskoder');
    assert.ok(rows.every((r) => r.kode_hash !== sendt[0].kode && r.kode_hash.length === 64));
  } finally {
    await db.close();
  }
});

test('maks 5 feilforsøk per kode, og ny kode ugyldiggjør den gamle', async () => {
  const { db, sendt } = await oppsett();
  try {
    await kjor(api.kode, { method: 'POST', body: { epost: 'sted@example.no' }, ip: '10.2.0.1' });
    const riktig = sendt.at(-1).kode;
    const feil = riktig === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await kjor(api.logginn, { method: 'POST', body: { epost: 'sted@example.no', kode: feil }, ip: '10.2.0.1' });
    assert.equal((await kjor(api.logginn, { method: 'POST', body: { epost: 'sted@example.no', kode: riktig }, ip: '10.2.0.1' })).statusCode, 401,
      'riktig kode avvises etter 5 feil');

    await kjor(api.kode, { method: 'POST', body: { epost: 'sted@example.no' }, ip: '10.2.0.2' });
    const gammel = sendt.at(-1).kode;
    await kjor(api.kode, { method: 'POST', body: { epost: 'sted@example.no' }, ip: '10.2.0.2' });
    const ny = sendt.at(-1).kode;
    if (gammel !== ny) {
      assert.equal((await kjor(api.logginn, { method: 'POST', body: { epost: 'sted@example.no', kode: gammel }, ip: '10.2.0.3' })).statusCode, 401);
    }
    assert.equal((await kjor(api.logginn, { method: 'POST', body: { epost: 'sted@example.no', kode: ny }, ip: '10.2.0.3' })).statusCode, 200);

    // Maks 3 koder per e-post per 10 minutter (to brukt over + én til = 3, den fjerde stoppes)
    await kjor(api.kode, { method: 'POST', body: { epost: 'sted@example.no' }, ip: '10.2.0.4' });
    assert.equal((await kjor(api.kode, { method: 'POST', body: { epost: 'sted@example.no' }, ip: '10.2.0.5' })).statusCode, 429);
  } finally {
    await db.close();
  }
});

test('oppmøteansvarlig ser bare sitt sted og kan sjekke ut, inn og angre', async () => {
  const { db, sendt, backupId } = await oppsett();
  try {
    assert.equal((await kjor(api.meg)).statusCode, 401);
    const cookie = await loggInn('sted@example.no', sendt);

    const meg = await kjor(api.meg, { cookie });
    assert.deepEqual(meg.data.steder.map((s) => s.id), [STED_A.id]);
    assert.equal(meg.data.rolle, 'Oppmøtested');

    const liste = await kjor(api.liste, { cookie, query: { sted: STED_A.id } });
    assert.equal(liste.statusCode, 200);
    assert.deepEqual(liste.data.bossebaerere.map((b) => `${b.kilde}:${b.fornavn}`), ['Aksjonsportalen:Anne', 'Backup:Cecilie']);
    assert.equal((await kjor(api.liste, { cookie, query: { sted: STED_B.id } })).statusCode, 403);

    const post = (personRef, handling, stedId = STED_A.id) =>
      kjor(api.status, { method: 'POST', cookie, body: { personRef, stedId, handling } });

    let r = await post('ap:ap1', 'ut');
    assert.ok(r.data.utTid && !r.data.innTid);
    r = await post('ap:ap1', 'inn');
    assert.ok(r.data.utTid && r.data.innTid);
    r = await post('ap:ap1', 'angre');
    assert.ok(r.data.utTid && !r.data.innTid, 'angre etter inn → tilbake til ute');
    r = await post(`bk:${backupId}`, 'inn');
    assert.ok(r.data.utTid && r.data.innTid, 'inn uten ut setter begge');

    assert.equal((await post('ap:ap2', 'ut', STED_B.id)).statusCode, 403, 'sted uten tilgang');
    assert.equal((await post('ap:ap2', 'ut')).statusCode, 404, 'personen hører ikke til dette stedet');
    assert.equal((await post('ap:ap1', 'slett')).statusCode, 400);

    const { rows } = await db.query("SELECT epost, handling FROM hendelser WHERE handling <> 'logget inn' ORDER BY id");
    assert.deepEqual(rows.map((x) => x.handling), ['ut', 'inn', 'angre', 'inn']);
    assert.ok(rows.every((x) => x.epost === 'sted@example.no'));

    const ut = await kjor(api.loggut, { method: 'POST' });
    assert.match(ut.hoder['set-cookie'], /Max-Age=0/);
  } finally {
    await db.close();
  }
});

test('kommuneansvarlig ser stedene i kommunen; fjernet tilgang og forfalsket cookie avvises', async () => {
  const { db, sendt } = await oppsett();
  try {
    const cookie = await loggInn('kommune@example.no', sendt, '10.3.0.1');
    const meg = await kjor(api.meg, { cookie });
    assert.ok(meg.data.steder.length >= 1);
    assert.ok(meg.data.steder.every((s) => s.kommune === STED_B.kommune));
    assert.equal((await kjor(api.liste, { cookie, query: { sted: STED_B.id } })).data.bossebaerere.length, 1);

    const [navn, verdi] = cookie.split('=');
    const [e, utloper] = verdi.split('.');
    const annen = Buffer.from('nasjonal@tvaksjonen.no').toString('base64url');
    assert.equal((await kjor(api.meg, { cookie: `${navn}=${annen}.${utloper}.${verdi.split('.')[2]}` })).statusCode, 401);
    assert.equal((await kjor(api.meg, { cookie: `${navn}=${e}.${utloper}.feil` })).statusCode, 401);

    await db.query("DELETE FROM ansvarlige WHERE epost = 'kommune@example.no'");
    assert.equal((await kjor(api.meg, { cookie })).statusCode, 401, 'fjernet fra lista → mister tilgang med en gang');
  } finally {
    await db.close();
  }
});

test('anon har ingen tilgang til tabellene eller funksjonene i nødmodulen', async () => {
  const db = await nyDb();
  try {
    await db.exec('SET ROLE anon');
    for (const sql of ['SELECT * FROM ansvarlige', 'SELECT * FROM bossebaerere_import', 'SELECT * FROM oppmote_status',
      'SELECT * FROM engangskoder', 'SELECT * FROM hendelser', "SELECT * FROM hent_ansvarlig('a@b.no')",
      "SELECT * FROM bossebaerere_for_sted('x')", "SELECT bruk_kode('a@b.no', 'x')"]) {
      await assert.rejects(db.query(sql), /permission denied/, sql);
    }
  } finally {
    await db.close();
  }
});

test('feil i e-postsending gir tydelig feilmelding', async () => {
  const { db } = await oppsett();
  try {
    settEpostSender(async () => { throw new Error('Resend nede'); });
    const r = await kjor(api.kode, { method: 'POST', body: { epost: 'sted@example.no' }, ip: '10.4.0.1' });
    assert.equal(r.statusCode, 503);
    assert.equal(r.data.kode, 'epost_feil');
  } finally {
    await db.close();
  }
});
