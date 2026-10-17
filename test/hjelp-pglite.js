'use strict';

// Felles testoppsett: PGlite med Supabase-rollene og begge skjemaene.
const fs = require('node:fs');
const path = require('node:path');

async function nyDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
                 GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`);
  for (const f of ['schema.sql', 'schema-ansvarlig.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', f), 'utf8'));
  }
  return db;
}

/** Utfører i samme form som supabaseKall: funksjonsnavn + navngitte argumenter. */
function pgliteKall(db) {
  return async (funksjon, args = {}, { form = 'rader' } = {}) => {
    const navn = Object.keys(args);
    const params = navn.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const verdier = navn.map((k) => args[k]);
    if (form === 'rader') return (await db.query(`SELECT * FROM ${funksjon}(${params})`, verdier)).rows;
    return (await db.query(`SELECT ${funksjon}(${params}) AS v`, verdier)).rows[0].v;
  };
}

module.exports = { nyDb, pgliteKall };
