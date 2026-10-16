#!/usr/bin/env node
'use strict';

/**
 * Kjører Vercel-oppsettet lokalt uten Vercel-konto: public/ som statiske filer og api/*.js som funksjoner.
 * Uten SUPABASE_URL brukes SQLite i var/, så du kan teste uten Supabase også.
 *
 * Bruk:  ADMIN_PASSWORD='et-langt-passord' node scripts/vercel-lokal.js
 */

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

if (!process.env.STORAGE) process.env.STORAGE = process.env.SUPABASE_URL ? 'supabase' : 'sqlite';

const ROT = path.join(__dirname, '..');
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
app.listen(port, () => console.log(`Vercel-oppsett lokalt på http://localhost:${port} (lagring: ${process.env.STORAGE})`));
