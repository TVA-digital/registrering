'use strict';

// Kjører supabase/schema.sql mot ekte Postgres (PGlite) og tester databasefunksjonene.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKJEMA = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');

async function nyDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  // Rollene som finnes i alle Supabase-prosjekter
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
                 GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
                 -- Supabase gir som standard anon/authenticated tilgang til alt nytt i public
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`);
  await db.exec(SKJEMA);
  return db;
}

const reg = (epost, sted = 'a', maks = null) => db_call =>
  db_call.query('SELECT registrer_pamelding($1,$2,$3,$4,$5,$6,$7) AS r',
    ['Ola', 'Nordmann', epost, '41234567', 1980, sted, maks]);

test('skjemaet kan kjøres flere ganger', async () => {
  const db = await nyDb();
  await db.exec(SKJEMA);
  await db.close();
});

test('registrerer, avviser duplikat og stenger fullt sted', async () => {
  const db = await nyDb();
  await db.exec('SET ROLE service_role');

  const { rows } = await reg('a@example.no')(db);
  assert.match(rows[0].r.id, /^[0-9a-f-]{36}$/);

  await assert.rejects(reg('a@example.no', 'b')(db), /EPOST_BRUKT/);

  await reg('b@example.no', 'lite', 2)(db);
  await reg('c@example.no', 'lite', 2)(db);
  await assert.rejects(reg('d@example.no', 'lite', 2)(db), /STED_FULLT/);
  await reg('d@example.no', 'lite', null)(db); // uten grense går det

  const antall = await db.query('SELECT * FROM antall_per_sted() ORDER BY sted_id');
  assert.deepEqual(antall.rows.map((r) => [r.sted_id, Number(r.antall)]), [['a', 1], ['lite', 3]]);
  await db.close();
});

test('rate limiting', async () => {
  const db = await nyDb();
  await db.exec('SET ROLE service_role');
  const kall = () => db.query('SELECT begrens($1, 2, 60) AS ok', ['reg:abc']).then((r) => r.rows[0].ok);
  assert.equal(await kall(), true);
  assert.equal(await kall(), true);
  assert.equal(await kall(), false);
  assert.equal((await db.query('SELECT begrens($1, 2, 60) AS ok', ['reg:annen'])).rows[0].ok, true);
  await db.close();
});

test('anon og authenticated har ingen tilgang til data eller funksjoner', async () => {
  const db = await nyDb();
  for (const rolle of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${rolle}`);
    await assert.rejects(db.query('SELECT * FROM registreringer'), /permission denied/);
    await assert.rejects(db.query("INSERT INTO registreringer (fornavn, etternavn, epost, telefon, fodselsar, sted_id) VALUES ('a','b','c@d.no','1',1990,'x')"), /permission denied/);
    await assert.rejects(reg('x@example.no')(db), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM antall_per_sted()'), /permission denied/);
    await db.exec('RESET ROLE');
  }
  await db.close();
});

test('databasen avviser ugyldige data selv om API-et skulle slippe dem gjennom', async () => {
  const db = await nyDb();
  await db.exec('SET ROLE service_role');
  await assert.rejects(reg('Stor@Example.no')(db), /check/i);
  await assert.rejects(
    db.query('SELECT registrer_pamelding($1,$2,$3,$4,$5,$6,$7)', ['', 'B', 'e@f.no', '1', 1990, 'x', null]),
    /check/i);
  await db.close();
});
