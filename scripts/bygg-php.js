#!/usr/bin/env node
'use strict';

/**
 * Bygger PHP-pakken for webhotell: dist/pamelding-backup/ og dist/pamelding-backup.zip
 *
 * Bruk:  node scripts/bygg-php.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROT = path.join(__dirname, '..');
const DIST = path.join(ROT, 'dist');
const UT = path.join(DIST, 'pamelding-backup');
const ZIP = path.join(DIST, 'pamelding-backup.zip');

const LES_MEG = `BACKUP-PÅMELDING FOR BØSSEBÆRERE – TV-AKSJONEN 2026
====================================================

Slik legger du løsningen på et webhotell med PHP:

1. Åpne config.php i en teksteditor og bytt 'BYTT-MEG' til et langt passord
   (minst 12 tegn). Det er passordet til admin.html. Lagre.

2. Last opp HELE innholdet i denne mappen til en mappe på webhotellet,
   f.eks. /pamelding, med FTP/SFTP eller filbehandleren til webhotellet.
   Husk de skjulte filene .htaccess og data/.htaccess.

3. Åpne https://<ditt-domene>/pamelding/sjekk.php i nettleseren.
   Alt skal være grønt. Slett sjekk.php etterpå.

4. Test påmeldingen på https://<ditt-domene>/pamelding/
   og se påmeldingene på https://<ditt-domene>/pamelding/admin.html

Påmeldingene lagres i en SQLite-fil i mappen data/ (tilfeldig filnavn,
sperret for nedlasting). Last ned CSV fra admin.html og slett data-mappen
når påmeldingene er overført til Aksjonsportalen.

Krav: PHP 7.4 eller nyere med pdo_sqlite (finnes hos de fleste webhotell),
Apache med .htaccess, og HTTPS.
`;

function kopier(fra, til) {
  fs.mkdirSync(path.dirname(til), { recursive: true });
  fs.copyFileSync(fra, til);
}

function main() {
  fs.rmSync(UT, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });
  fs.mkdirSync(UT, { recursive: true });

  // Forsiden: relative stier og PHP-API
  let index = fs.readFileSync(path.join(ROT, 'public', 'index.html'), 'utf8');
  index = index
    .replace('<html lang="nb">', '<html lang="nb" data-api="php">')
    .replace('href="/styles.css"', 'href="styles.css"')
    .replace('src="/app.js"', 'src="app.js"')
    .replace(/src="\/img\//g, 'src="img/');
  if (/(?:src|href)="\/(?!\/)/.test(index)) throw new Error('index.html har fortsatt absolutte stier');
  fs.writeFileSync(path.join(UT, 'index.html'), index);

  for (const f of ['styles.css', 'app.js', 'admin.css', 'admin.js', 'img/hero-1.jpg', 'img/hero-2.jpg', 'img/kampanje.png']) {
    kopier(path.join(ROT, 'public', f), path.join(UT, f));
  }
  for (const f of ['api.php', 'config.php', 'sjekk.php', 'admin.html', '.htaccess', 'data/.htaccess', 'data/index.html']) {
    kopier(path.join(ROT, 'php', f), path.join(UT, f));
  }
  kopier(path.join(ROT, 'data', 'oppmotesteder.json'), path.join(UT, 'data', 'oppmotesteder.json'));
  fs.writeFileSync(path.join(UT, 'LES-MEG.txt'), LES_MEG);

  execFileSync('zip', ['-qr', ZIP, 'pamelding-backup'], { cwd: DIST });
  console.log(`Skrev ${path.relative(process.cwd(), ZIP)} (${Math.round(fs.statSync(ZIP).size / 1024)} KB)`);
}

try {
  main();
} catch (err) {
  console.error(`Bygging av PHP-pakken feilet: ${err.message}`);
  process.exit(1);
}
