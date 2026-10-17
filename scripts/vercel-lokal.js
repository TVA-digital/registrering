#!/usr/bin/env node
'use strict';

/**
 * Kjører Vercel-oppsettet lokalt uten Vercel-konto: public/ som statiske filer og api/*.js som funksjoner.
 *
 *   ADMIN_PASSWORD='et-langt-passord' node scripts/vercel-lokal.js           SQLite i var/ (påmelding og admin)
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… … node scripts/vercel-lokal.js   mot ekte Supabase
 *   ADMIN_PASSWORD='…' node scripts/vercel-lokal.js --demo                    alt i minnet med fiktive data, også
 *                                                                             nødmodulen; engangskoder skrives i terminalen
 */

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const DEMO = process.argv.includes('--demo');
if (!process.env.STORAGE) process.env.STORAGE = process.env.SUPABASE_URL && !DEMO ? 'supabase' : 'sqlite';
if (DEMO && !process.env.SQLITE_FILE) process.env.SQLITE_FILE = ':memory:';

const ROT = path.join(__dirname, '..');

async function demoOppsett() {
  const vercel = require('../src/vercel');
  const { AnsvarligStorage } = require('../src/storage/ansvarlig');
  const { settEpostSender } = require('../src/epost');
  const { nyDb, pgliteKall } = require('../test/hjelp-pglite');

  const db = await nyDb();
  const brannas = vercel.steder.find((s) => s.navn === 'Brånås skole') || vercel.steder[0];
  const annet = vercel.steder.find((s) => s.kommune === brannas.kommune && s.id !== brannas.id) || vercel.steder[1];
  await db.query(`INSERT INTO ansvarlige (epost, navn, tilganger) VALUES
    ('demo@tvaksjonen.no', 'Demo Nasjonal', '{nasjonal}'),
    ('kommune@demo.no', 'Demo Kommune', $1),
    ('sted@demo.no', 'Demo Oppmøteansvarlig', $2)`,
  [[`kommune:${brannas.fylke}/${brannas.kommune}`], [`sted:${brannas.id}`]]);
  const fiktive = [['Ada', 'Lovelace'], ['Bjørg', 'Bøsse'], ['Carl', 'Dør'], ['Dina', 'Rode'], ['Erik', 'Fylke'],
    ['Frida', 'Kommune'], ['Geir', 'Givesen'], ['Hanne', 'Hjelp'], ['Ivar', 'Innsamling'], ['Jorunn', 'Jakke']];
  let i = 0;
  for (const [fornavn, etternavn] of fiktive) {
    i++;
    await db.query(`INSERT INTO bossebaerere_import (ekstern_id, fornavn, etternavn, epost, telefon, sted_id)
      VALUES ($1, $2, $3, $4, $5, $6)`, [`demo${i}`, fornavn, etternavn, `demo${i}@example.no`, `9000000${i % 10}`,
      i <= 8 ? brannas.id : annet.id]);
  }
  vercel.settAnsvarligStorage(new AnsvarligStorage(pgliteKall(db)));
  settEpostSender(async ({ epost, kode }) => console.log(`[demo] Engangskode til ${epost}: ${kode}`));
  console.log(`[demo] Logg inn på /ansvarlig med demo@tvaksjonen.no, kommune@demo.no eller sted@demo.no (${brannas.navn}).`);
}

async function main() {
  if (DEMO) await demoOppsett();

  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.all(/^\/api\/(.+)$/, (req, res) => {
    const navn = req.params[0].replace(/[^a-z/]/g, '');
    const fil = path.join(ROT, 'api', `${navn}.js`);
    if (!fs.existsSync(fil)) return res.status(404).json({ kode: 'ikke_funnet', feil: 'Fant ikke ressursen.' });
    return require(fil)(req, res);
  });
  app.use(express.static(path.join(ROT, 'public'), { extensions: ['html'] }));

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Vercel-oppsett lokalt på http://localhost:${port} (lagring: ${process.env.STORAGE}${DEMO ? ', demo' : ''})`));
}

main().catch((err) => {
  console.error('Oppstart feilet:', err);
  process.exit(1);
});
