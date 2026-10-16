'use strict';

/** Felles hjelpere for Express-serveren og Vercel-funksjonene. */

const TIDSSONE = 'Europe/Oslo';

function formaterTid(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dato = d.toLocaleDateString('nb-NO', { timeZone: TIDSSONE, day: '2-digit', month: '2-digit', year: 'numeric' });
  const kl = d.toLocaleTimeString('nb-NO', { timeZone: TIDSSONE, hour: '2-digit', minute: '2-digit' });
  return `${dato}, kl. ${kl}`;
}

/** Hvor mange påmeldinger backupen kan ta for et sted (null = ubegrenset). */
function maksForBackup(sted) {
  if (!sted.autoStenging || sted.onsket == null) return null;
  return Math.max(0, sted.onsket - sted.pameldtHovedsystem);
}

function adresse(s) {
  return [s.gate, [s.postnr, s.poststed].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/** Oppmøtestedene slik nettleseren får dem, med fullt-flagg ut fra antall påmeldte i backupen. */
function stederForApi(steder, antall) {
  return steder.map((s) => {
    const maks = maksForBackup(s);
    return {
      id: s.id,
      navn: s.navn,
      fylke: s.fylke,
      kommune: s.kommune,
      adresse: adresse(s),
      tid: formaterTid(s.tid),
      tilgjengelighet: s.tilgjengelighet,
      fullt: maks !== null && (antall.get(s.id) || 0) >= maks,
      fulltTekst: s.fulltTekst,
    };
  });
}

function stedForKvittering(sted) {
  return { navn: sted.navn, adresse: adresse(sted), tid: formaterTid(sted.tid) };
}

function csvCelle(v) {
  let s = v == null ? '' : String(v);
  // Hindrer formel-injeksjon når fila åpnes i Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HODE = ['Registrert', 'Fornavn', 'Etternavn', 'E-post', 'Telefon', 'Fødselsår', 'Fylke',
  'Kommune', 'Oppmøtested', 'Oppmøtested-ID', 'Adresse', 'Oppmøtetid', 'Samtykke'];

/** Lager hele CSV-fila (med BOM, slik at Excel leser æøå riktig). */
function lagCsv(registreringer, stedMap) {
  const linjer = registreringer.map((r) => {
    const s = stedMap.get(r.stedId) || {};
    return [
      formaterTid(r.opprettet), r.fornavn, r.etternavn, r.epost, r.telefon, r.fodselsar, s.fylke,
      s.kommune, s.navn, r.stedId, s.id ? adresse(s) : '', formaterTid(s.tid), r.samtykke ? 'Ja' : 'Nei',
    ].map(csvCelle).join(';');
  });
  return '﻿' + [CSV_HODE.join(';'), ...linjer].join('\r\n') + '\r\n';
}

function csvFilnavn() {
  const stempel = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `pameldinger-backup-${stempel}.csv`;
}

/** Antall per fylke, sortert synkende – til admin-oversikten. */
function oppsummering(antall, stedMap) {
  const perFylke = new Map();
  let totalt = 0;
  for (const [id, n] of antall) {
    const fylke = stedMap.get(id)?.fylke || 'Ukjent';
    perFylke.set(fylke, (perFylke.get(fylke) || 0) + n);
    totalt += n;
  }
  return {
    totalt,
    perFylke: [...perFylke].sort((a, b) => b[1] - a[1]).map(([fylke, n]) => ({ fylke, antall: n })),
  };
}

module.exports = {
  TIDSSONE, formaterTid, maksForBackup, adresse, stederForApi, stedForKvittering,
  csvCelle, lagCsv, csvFilnavn, oppsummering,
};
