'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lagApp } = require('../src/app');
const { csvCelle } = require('../src/hjelpere');
const { SqliteStorage } = require('../src/storage/sqlite');

const data = {
  steder: [
    { id: 'aapent', navn: 'Åpen skole', fylke: 'Akershus', kommune: 'Lillestrøm', gate: 'Veien 1', postnr: '2000',
      poststed: 'Lillestrøm', tid: '2026-10-18T13:30:00.000Z', tilgjengelighet: 'Trinnfri adkomst', fulltTekst: '',
      autoStenging: false, onsket: 10, pameldtHovedsystem: 50 },
    { id: 'nesten-fullt', navn: 'Lite sted', fylke: 'Oslo', kommune: 'Sagene', gate: '', postnr: '0450', poststed: 'Oslo',
      tid: null, tilgjengelighet: '', fulltTekst: 'Vi har full dekning her.', autoStenging: true, onsket: 5,
      pameldtHovedsystem: 4 },
  ],
};

const stille = { info() {}, warn() {}, error() {} };

async function medServer(fn) {
  const storage = new SqliteStorage({ fil: ':memory:' });
  await storage.init();
  const app = lagApp({ storage, data, adminPassord: 'hemmelig-passord', personvernUrl: 'https://example.no', logger: stille,
    rateLimit: { maks: 1000 } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
    await storage.lukk();
  }
}

const post = (base, body) =>
  fetch(`${base}/api/registrering`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const person = (epost, stedId = 'aapent') => ({
  fornavn: 'Ola', etternavn: 'Nordmann', epost, telefon: '41234567', fodselsar: '1980', samtykke: true, stedId,
});

test('lister oppmøtesteder med formatert tid og adresse', () =>
  medServer(async (base) => {
    const steder = await (await fetch(`${base}/api/oppmotesteder`)).json();
    assert.equal(steder.length, 2);
    assert.equal(steder[0].tid, '18.10.2026, kl. 15:30');
    assert.equal(steder[0].adresse, 'Veien 1, 2000 Lillestrøm');
    assert.equal(steder[0].fullt, false, 'stedet uten automatisk stenging er aldri fullt');
    assert.equal(steder[1].fullt, false);
  }));

test('registrerer, avviser duplikat e-post og stenger fullt sted', () =>
  medServer(async (base) => {
    let res = await post(base, person('a@example.no'));
    assert.equal(res.status, 201);

    res = await post(base, person('A@Example.no'));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).kode, 'epost_brukt');

    // Lite sted: ønsket 5, 4 i hovedsystemet => backupen tar én til.
    assert.equal((await post(base, person('b@example.no', 'nesten-fullt'))).status, 201);
    res = await post(base, person('c@example.no', 'nesten-fullt'));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { kode: 'sted_fullt', feil: 'Vi har full dekning her.', felt: 'stedId' });

    const steder = await (await fetch(`${base}/api/oppmotesteder`)).json();
    assert.equal(steder.find((s) => s.id === 'nesten-fullt').fullt, true);
  }));

test('ukjent sted, ugyldig JSON og honningkrukke', () =>
  medServer(async (base) => {
    assert.equal((await post(base, person('x@example.no', 'finnes-ikke'))).status, 400);
    const res = await fetch(`${base}/api/registrering`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.equal((await post(base, { ...person('bot@example.no'), nettside: 'spam' })).status, 201);
    const csv = await (await fetch(`${base}/admin/registreringer.csv`, {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:hemmelig-passord').toString('base64') },
    })).text();
    assert.ok(!csv.includes('bot@example.no'), 'robot-innsending skal ikke lagres');
  }));

test('admin krever passord og eksporterer CSV', () =>
  medServer(async (base) => {
    assert.equal((await fetch(`${base}/admin`)).status, 401);
    const feil = Buffer.from('admin:feil').toString('base64');
    assert.equal((await fetch(`${base}/admin`, { headers: { Authorization: `Basic ${feil}` } })).status, 401);

    await post(base, person('eksport@example.no'));
    const auth = 'Basic ' + Buffer.from('admin:hemmelig-passord').toString('base64');
    const res = await fetch(`${base}/admin/registreringer.csv`, { headers: { Authorization: auth } });
    assert.equal(res.status, 200);
    const linjer = (await res.text()).replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(linjer.length, 2);
    assert.match(linjer[1], /Ola;Nordmann;eksport@example\.no;41234567;1980;Akershus;Lillestrøm;Åpen skole;aapent/);
  }));

test('csvCelle hindrer formel-injeksjon og quoter riktig', () => {
  assert.equal(csvCelle('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCelle('a;b'), '"a;b"');
  assert.equal(csvCelle(null), '');
});
