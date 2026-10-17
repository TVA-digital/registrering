#!/usr/bin/env node
'use strict';

/**
 * Importerer påmeldte bøssebærere fra Aksjonsportalen-eksporten (BB_*.csv) til Supabase,
 * slik at ansvarlige kan se og sjekke dem ut/inn i nødmodulen.
 *
 * Bruk:  node scripts/import-bossebaerere.js <BB-eksport.csv>            (tørrkjøring – skriver ingenting)
 *        SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/import-bossebaerere.js <fil> --skriv
 *
 * Kjør scripts/import-oppmotesteder.js med fersk oppmøtested-eksport først, så stedene finnes.
 * Bare de som «Deltar i år» tas med. Personopplysningene skrives kun til databasen, aldri til repoet.
 */

const { lesCsv, krevKolonner, lagStedsoppslag, lesSteder, supabase, synkroniser } = require('./import-felles');

const K = {
  id: 'ID', fornavn: 'User.First Name', etternavn: 'User.Last Name', epost: 'User.Email', telefon: 'User.Phone',
  fylke: 'Fylke', kommune: 'Kommune', sted: 'Oppmøtested', deltar: 'Deltar i år',
};

async function main() {
  const args = process.argv.slice(2);
  const fil = args.find((a) => !a.startsWith('--'));
  if (!fil) throw new Error('Bruk: node scripts/import-bossebaerere.js <BB-eksport.csv> [--skriv]');

  const { hode, rader, avvist } = lesCsv(fil);
  krevKolonner(hode, Object.values(K), fil);
  const oppslag = lagStedsoppslag(lesSteder());

  const stat = { lest: rader.length, deltarIkke: 0, utenSted: 0, ukjentSted: 0, avvist };
  const ut = [];
  const sett = new Set();
  for (const r of rader) {
    if (String(r[K.deltar]).trim() !== 'true') { stat.deltarIkke++; continue; }
    if (!String(r[K.sted]).trim()) { stat.utenSted++; continue; }
    const sted = oppslag.finn(r[K.fylke], r[K.kommune], r[K.sted]);
    if (!sted) { stat.ukjentSted++; continue; }
    const id = String(r[K.id]).trim();
    if (!id || sett.has(id)) continue;
    sett.add(id);
    ut.push({
      ekstern_id: id,
      fornavn: String(r[K.fornavn]).trim(),
      etternavn: String(r[K.etternavn]).trim(),
      epost: String(r[K.epost]).trim().toLowerCase(),
      telefon: String(r[K.telefon]).trim(),
      sted_id: sted.id,
    });
  }

  console.log(`Leste ${stat.lest} rader: ${ut.length} klare for import, ${stat.deltarIkke} deltar ikke i år, ` +
    `${stat.utenSted} uten oppmøtested, ${stat.ukjentSted} med ukjent oppmøtested, ${stat.avvist} ødelagte rader.`);
  if (oppslag.tvetydige.size) {
    console.log(`Like stedsnavn i samme kommune (valgte stedet med flest påmeldte): ${[...oppslag.tvetydige].join('; ')}`);
  }
  console.log(`Fordelt på ${new Set(ut.map((r) => r.sted_id)).size} oppmøtesteder.`);

  if (!args.includes('--skriv')) {
    console.log('Tørrkjøring – ingenting er skrevet. Legg til --skriv for å importere til Supabase.');
    return;
  }
  const res = await synkroniser(supabase(), 'bossebaerere_import', 'ekstern_id', ut);
  console.log(`Importert: ${res.skrevet} bøssebærere skrevet, ${res.slettet} som ikke lenger finnes i eksporten er fjernet.`);
}

main().catch((err) => {
  console.error(`Import feilet: ${err.message}`);
  process.exit(1);
});
