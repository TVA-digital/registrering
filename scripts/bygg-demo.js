#!/usr/bin/env node
'use strict';

/**
 * Bygger en selvstendig demo-fil (dist/demo.html) av skjemaet, uten server.
 * API-kallene besvares i nettleseren og ingenting lagres – kun for å vise fram løpet.
 *
 * Bruk:  node scripts/bygg-demo.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROT = path.join(__dirname, '..');
const les = (f) => fs.readFileSync(path.join(ROT, f), 'utf8');
const dataUri = (f, type) => `data:${type};base64,${fs.readFileSync(path.join(ROT, f)).toString('base64')}`;

function main() {
  const { formaterTid } = require('../src/app');
  const data = JSON.parse(les('data/oppmotesteder.json'));

  // Samme felt som /api/oppmotesteder returnerer
  const steder = data.steder.map((s) => ({
    id: s.id,
    navn: s.navn,
    fylke: s.fylke,
    kommune: s.kommune,
    adresse: [s.gate, [s.postnr, s.poststed].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    tid: formaterTid(s.tid),
    tilgjengelighet: s.tilgjengelighet,
    fullt: false,
    fulltTekst: s.fulltTekst,
  }));

  const html = les('public/index.html');
  const body = html.slice(html.indexOf('<main'), html.indexOf('</main>') + '</main>'.length)
    .replace(/\/img\/hero-1\.jpg/g, dataUri('public/img/hero-1.jpg', 'image/jpeg'))
    .replace(/\/img\/hero-2\.jpg/g, dataUri('public/img/hero-2.jpg', 'image/jpeg'))
    .replace(/\/img\/kampanje\.png/g, dataUri('public/img/kampanje.png', 'image/png'));

  const mock = `
(() => {
  const STEDER = ${JSON.stringify(steder).replace(/</g, '\\u003c')};
  const brukt = new Set();
  const svar = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ekte = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('oppmotesteder')) return svar(200, STEDER);
    if (u.endsWith('konfig')) return svar(200, { personvernUrl: 'https://www.tvaksjonen.no/personvern' });
    if (u.endsWith('registrering')) {
      await new Promise((r) => setTimeout(r, 400));
      const b = JSON.parse(opts.body || '{}');
      const epost = String(b.epost || '').trim().toLowerCase();
      if (brukt.has(epost)) return svar(409, { kode: 'epost_brukt', felt: 'epost',
        feil: 'Denne e-postadressen er allerede registrert. En e-postadresse kan kun brukes én gang.' });
      brukt.add(epost);
      const s = STEDER.find((x) => x.id === b.stedId) || {};
      return svar(201, { ok: true, sted: { navn: s.navn, adresse: s.adresse, tid: s.tid } });
    }
    return ekte(url, opts);
  };
})();`;

  const demoCss = `
.demo-banner { background: #0d203b; color: #fff; text-align: center; font: 13px/1.4 Arial, Helvetica, sans-serif;
  padding: 8px 16px; }
html, body { background: #f4f4f4; color: #1f1f1f; }`;

  const ut = `<title>Bøssebærer-påmelding backup</title>
<style>${les('public/styles.css')}${demoCss}</style>
<div class="demo-banner" role="note">Demo av backup-påmeldingen – påmeldinger lagres ikke</div>
${body}
<script>${mock}</script>
<script>${les('public/app.js')}</script>
`;

  const fil = path.join(ROT, 'dist', 'demo.html');
  fs.mkdirSync(path.dirname(fil), { recursive: true });
  fs.writeFileSync(fil, ut);
  console.log(`Skrev ${path.relative(process.cwd(), fil)} (${Math.round(ut.length / 1024)} KB)`);
}

try {
  main();
} catch (err) {
  console.error(`Bygging av demo feilet: ${err.message}`);
  process.exit(1);
}
