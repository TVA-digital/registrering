#!/usr/bin/env node
'use strict';

/**
 * Bygger lista over hvem som kan logge inn i nødmodulen, og hva de har tilgang til:
 *   - Oppmøteansvarlige fra oppmøtested-eksporten («Oppmøteansvarlig mail») → sitt sted
 *   - Komitémedlemmer (Komitemedlemmer_*.csv, aksjonsåret, «Deltar i år») etter «Tilgangsnivå»:
 *       «Tilgang til ett oppmøtested»     → stedet
 *       «Tilgang til hele kommunen/komité» → kommunen
 *       «Tilgang til hele fylket»          → fylket
 *       «Admin»                            → nasjonal, men bare for e-postdomenene i --admin-domener
 *     «Sjåfør» og utgåtte nivåer får ikke tilgang.
 *   - Ekstra nasjonale brukere med --nasjonal=a@x.no,b@y.no
 *
 * Bruk:  node scripts/import-ansvarlige.js --steder=<oppmøtested.csv> --komite=<komité.csv>   (tørrkjøring)
 *        … --skriv   (krever SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY)
 * Valg:  --aksjon=2026  --admin-domener=tvaksjonen.no,tv-aksjonen.no  --nasjonal=…
 */

const { lesCsv, krevKolonner, lagStedsoppslag, lesSteder, supabase, synkroniser, argument } = require('./import-felles');

const EPOST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function main() {
  const args = process.argv.slice(2);
  const stederFil = argument(args, 'steder');
  const komiteFil = argument(args, 'komite');
  const aksjon = argument(args, 'aksjon') || '2026';
  const adminDomener = (argument(args, 'admin-domener') || 'tvaksjonen.no,tv-aksjonen.no')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const ekstraNasjonal = (argument(args, 'nasjonal') || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!stederFil && !komiteFil && !ekstraNasjonal.length) {
    throw new Error('Bruk: node scripts/import-ansvarlige.js --steder=<oppmøtested.csv> --komite=<komité.csv> [--skriv]');
  }

  const ansvarlige = new Map(); // epost → { navn, tilganger:Set }
  const stat = { oppmoteansvarlige: 0, sted: 0, kommune: 0, fylke: 0, admin: 0, adminUtelatt: 0, ingenTilgang: 0, ukjentSted: 0, utenEpost: 0 };
  const legg = (epost, navn, tilgang) => {
    const e = String(epost || '').trim().toLowerCase();
    if (!EPOST_RE.test(e)) { stat.utenEpost++; return; }
    if (!ansvarlige.has(e)) ansvarlige.set(e, { navn: '', tilganger: new Set() });
    const a = ansvarlige.get(e);
    if (!a.navn && navn) a.navn = navn;
    a.tilganger.add(tilgang);
  };

  const steder = lesSteder();
  const kjente = new Set(steder.map((s) => s.id));
  const oppslag = lagStedsoppslag(steder);

  if (stederFil) {
    const { hode, rader } = lesCsv(stederFil);
    krevKolonner(hode, ['ID', 'Oppmøteansvarlig mail', 'Oppmøteansvarlig fornavn', 'Oppmøteansvarlig etternavn'], stederFil);
    for (const r of rader) {
      if (!String(r['Oppmøteansvarlig mail']).trim()) continue;
      if (!kjente.has(r.ID)) { stat.ukjentSted++; continue; }
      legg(r['Oppmøteansvarlig mail'], `${r['Oppmøteansvarlig fornavn']} ${r['Oppmøteansvarlig etternavn']}`.trim(), `sted:${r.ID}`);
      stat.oppmoteansvarlige++;
    }
  }

  if (komiteFil) {
    const { hode, rader } = lesCsv(komiteFil);
    krevKolonner(hode, ['Aksjon', 'Deltar i år', 'User.Email', 'User.First Name', 'User.Last Name', 'Fylke', 'Kommune',
      'Oppmøtested', 'Tilgangsnivå'], komiteFil);
    for (const r of rader) {
      if (String(r.Aksjon).trim() !== aksjon || String(r['Deltar i år']).trim() !== 'true') continue;
      const navn = `${r['User.First Name']} ${r['User.Last Name']}`.trim();
      const niva = String(r['Tilgangsnivå']).trim();
      const epost = String(r['User.Email']).trim().toLowerCase();
      if (niva === 'Tilgang til ett oppmøtested') {
        const sted = oppslag.finn(r.Fylke, r.Kommune, r['Oppmøtested']);
        if (!sted) { stat.ukjentSted++; continue; }
        legg(epost, navn, `sted:${sted.id}`); stat.sted++;
      } else if (niva === 'Tilgang til hele kommunen/komité' && r.Kommune.trim()) {
        legg(epost, navn, `kommune:${r.Fylke.trim()}/${r.Kommune.trim()}`); stat.kommune++;
      } else if (niva === 'Tilgang til hele fylket' && r.Fylke.trim()) {
        legg(epost, navn, `fylke:${r.Fylke.trim()}`); stat.fylke++;
      } else if (niva === 'Admin') {
        if (adminDomener.includes(epost.split('@')[1])) { legg(epost, navn, 'nasjonal'); stat.admin++; }
        else stat.adminUtelatt++;
      } else {
        stat.ingenTilgang++;
      }
    }
  }

  for (const e of ekstraNasjonal) legg(e, '', 'nasjonal');

  const rader = [...ansvarlige].map(([epost, a]) => ({
    epost, navn: a.navn, tilganger: [...a.tilganger].sort(), oppdatert: new Date().toISOString(),
  }));
  const tell = (pre) => rader.filter((r) => r.tilganger.some((t) => t.startsWith(pre))).length;
  console.log(`${rader.length} personer kan logge inn: ${tell('nasjonal')} nasjonalt, ${tell('fylke:')} med fylke, ` +
    `${tell('kommune:')} med kommune, ${tell('sted:')} med oppmøtested(er).`);
  console.log(`Kilder: ${stat.oppmoteansvarlige} oppmøteansvarlige fra stedsfila; komité: ${stat.sted} sted, ${stat.kommune} kommune, ` +
    `${stat.fylke} fylke, ${stat.admin} admin (${stat.adminUtelatt} admin utenfor ${adminDomener.join('/')} utelatt), ` +
    `${stat.ingenTilgang} uten relevant tilgangsnivå. Hoppet over: ${stat.ukjentSted} ukjent sted, ${stat.utenEpost} uten gyldig e-post.`);

  if (!args.includes('--skriv')) {
    console.log('Tørrkjøring – ingenting er skrevet. Legg til --skriv for å oppdatere Supabase.');
    return;
  }
  const res = await synkroniser(supabase(), 'ansvarlige', 'epost', rader);
  console.log(`Oppdatert: ${res.skrevet} ansvarlige skrevet, ${res.slettet} som ikke lenger har tilgang er fjernet.`);
}

main().catch((err) => {
  console.error(`Import feilet: ${err.message}`);
  process.exit(1);
});
