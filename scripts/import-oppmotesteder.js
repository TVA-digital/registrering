#!/usr/bin/env node
'use strict';

/**
 * Konverterer eksporten av oppmøtesteder fra Aksjonsportalen (semikolonseparert CSV)
 * til data/oppmotesteder.json, som backup-løsningen bruker.
 *
 * Bruk:  node scripts/import-oppmotesteder.js <sti-til-eksport.csv>
 *
 * Alle steder tas med, fordi bøssebærere på stengte eller skjulte steder kan møte opp på aksjonsdagen
 * (nødmodulen for ansvarlige). Feltet `pamelding` sier om stedet kan velges i det offentlige skjemaet.
 *
 * Personopplysninger om oppmøteansvarlige (navn, e-post, telefon) tas bevisst IKKE med,
 * siden JSON-fila serveres offentlig til nettleseren.
 */

const fs = require('node:fs');
const path = require('node:path');

const OUTPUT = path.join(__dirname, '..', 'data', 'oppmotesteder.json');

function parseCsv(text, delimiter = ';') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (inQuotes) throw new Error('Ugyldig CSV: uavsluttet anførselstegn');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const bool = (v) => String(v).trim().toLowerCase() === 'true';
const int = (v) => {
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
};
const clean = (v) => String(v ?? '').replace(/\s+\n/g, '\n').trim();

// "GRIMSTAD" -> "Grimstad", "FEVIk" -> "Fevik". Lar blandet skrift som "Skedsmokorset" være i fred.
function normalizePlace(v) {
  const s = clean(v);
  if (!s) return s;
  const letters = s.replace(/[^A-Za-zÆØÅæøå]/g, '');
  const upper = letters.replace(/[^A-ZÆØÅ]/g, '').length;
  if (upper / letters.length < 0.6) return s;
  return s.toLowerCase().replace(/(^|[\s-])([a-zæøå])/g, (_, p, c) => p + c.toUpperCase());
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Bruk: node scripts/import-oppmotesteder.js <eksport.csv>');
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const [header, ...rows] = parseCsv(raw);

  // Kolonnenavnet "Fullt tilleggstekst" forekommer to ganger – vi bruker første forekomst.
  const col = (name) => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`Fant ikke kolonnen "${name}" i CSV-en`);
    return idx;
  };
  const C = {
    navn: col('Navn på oppmøtested'),
    fylke: col('Fylke'),
    gate: col('Adresse: Gate'),
    postnr: col('Adresse: Postnummer'),
    poststed: col('Adresse: Poststed'),
    pameldte: col('Antall påmeldte'),
    autoStenging: col('Automatisk stenging'),
    beskrivelse: col('Beskrivelse'),
    kommune: col('Kommune'),
    bydel: col('Bydel'),
    fulltTekst: col('Fullt tilleggstekst'),
    lat: col('Geo: Latitude (int)'),
    lng: col('Geo: Longitude (int)'),
    tid: col('Oppmøtetidspunkt'),
    apent: col('Åpent oppmøtested'),
    skjult: col('Skjult oppmøtested'),
    uuTekst: col('Universelt utformet: Tekst'),
    onsket: col('Ønsket antall bøssebærere'),
    id: col('ID'),
  };

  const stats = { totalt: rows.length, skjult: 0, stengt: 0, ugyldig: 0 };
  const steder = [];
  const seen = new Set();

  for (const r of rows) {
    if (r.length !== header.length) {
      stats.ugyldig++;
      continue;
    }
    const id = clean(r[C.id]);
    if (!id || seen.has(id)) {
      stats.ugyldig++;
      continue;
    }
    const skjult = bool(r[C.skjult]);
    const apent = bool(r[C.apent]);
    if (skjult) stats.skjult++;
    else if (!apent) stats.stengt++;
    seen.add(id);

    const kommune = clean(r[C.kommune]);
    const bydel = clean(r[C.bydel]);
    steder.push({
      id,
      navn: clean(r[C.navn]),
      fylke: clean(r[C.fylke]),
      kommune: bydel ? `${kommune} – ${bydel}` : kommune,
      gate: clean(r[C.gate]),
      postnr: clean(r[C.postnr]),
      poststed: normalizePlace(r[C.poststed]),
      tid: clean(r[C.tid]) || null,
      beskrivelse: clean(r[C.beskrivelse]),
      tilgjengelighet: clean(r[C.uuTekst]),
      fulltTekst: clean(r[C.fulltTekst]).replace(/^\.$/, ''),
      autoStenging: bool(r[C.autoStenging]),
      onsket: int(r[C.onsket]),
      pameldtHovedsystem: int(r[C.pameldte]) ?? 0,
      pamelding: apent && !skjult,
    });
  }

  const collator = new Intl.Collator('nb');
  steder.sort(
    (a, b) =>
      collator.compare(a.fylke, b.fylke) ||
      collator.compare(a.kommune, b.kommune) ||
      collator.compare(a.navn, b.navn)
  );

  const out = {
    generert: new Date().toISOString(),
    kilde: path.basename(file),
    antall: steder.length,
    steder,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(out) + '\n');

  console.log(
    `Skrev ${steder.length} oppmøtesteder til ${path.relative(process.cwd(), OUTPUT)} ` +
      `(${stats.skjult} skjulte og ${stats.stengt} stengte er med, men kan ikke velges ved påmelding; ${stats.ugyldig} ugyldige hoppet over)`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Import feilet: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseCsv, normalizePlace };
