'use strict';

const { ValideringsFeil } = require('./feil');

const AKSJONSAR = Number(process.env.AKSJONSAR) || 2026;
const MINSTEALDER = 15;
const SISTE_GYLDIGE_FODSELSAR = AKSJONSAR - MINSTEALDER;

// Pragmatisk e-postsjekk: én @, ingen mellomrom, punktum i domenet.
const EPOST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAVN_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

function tekst(verdi, felt, etikett, { maks = 100 } = {}) {
  const s = typeof verdi === 'string' ? verdi.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new ValideringsFeil(`${etikett} må fylles ut.`, felt);
  if (s.length > maks) throw new ValideringsFeil(`${etikett} kan ikke være lengre enn ${maks} tegn.`, felt);
  return s;
}

function normaliserEpost(epost) {
  return String(epost || '').trim().toLowerCase();
}

/** Norske nummer lagres som 8 siffer, utenlandske med landskode (+46...). */
function normaliserTelefon(raw) {
  let s = String(raw || '').replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\+47\d{8}$/.test(s)) return s.slice(3);
  if (/^\d{8}$/.test(s)) return s;
  if (/^\+\d{8,15}$/.test(s)) return s;
  return null;
}

/**
 * Validerer og normaliserer en påmelding. Kaster ValideringsFeil med feltnavn ved første feil.
 */
function validerPamelding(body) {
  if (!body || typeof body !== 'object') throw new ValideringsFeil('Ugyldig forespørsel.');

  const fornavn = tekst(body.fornavn, 'fornavn', 'Fornavn', { maks: 60 });
  if (!NAVN_RE.test(fornavn)) throw new ValideringsFeil('Fornavn inneholder ugyldige tegn.', 'fornavn');

  const etternavn = tekst(body.etternavn, 'etternavn', 'Etternavn', { maks: 60 });
  if (!NAVN_RE.test(etternavn)) throw new ValideringsFeil('Etternavn inneholder ugyldige tegn.', 'etternavn');

  const epost = normaliserEpost(tekst(body.epost, 'epost', 'E-postadresse', { maks: 254 }));
  if (!EPOST_RE.test(epost)) throw new ValideringsFeil('Skriv inn en gyldig e-postadresse.', 'epost');

  const telefon = normaliserTelefon(tekst(body.telefon, 'telefon', 'Telefonnummer', { maks: 20 }));
  if (!telefon) throw new ValideringsFeil('Skriv inn et gyldig telefonnummer (8 siffer).', 'telefon');

  const arTekst = String(body.fodselsar ?? '').trim();
  if (!/^\d{4}$/.test(arTekst)) throw new ValideringsFeil('Skriv inn fødselsår med fire siffer.', 'fodselsar');
  const fodselsar = Number(arTekst);
  if (fodselsar < 1900) throw new ValideringsFeil('Skriv inn et gyldig fødselsår.', 'fodselsar');
  if (fodselsar > SISTE_GYLDIGE_FODSELSAR) {
    throw new ValideringsFeil(`Du må være ${MINSTEALDER} år eller eldre for å registrere deg.`, 'fodselsar');
  }

  if (body.samtykke !== true) {
    throw new ValideringsFeil('Du må samtykke til behandling av personopplysninger.', 'samtykke');
  }

  const stedId = typeof body.stedId === 'string' ? body.stedId.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(stedId)) throw new ValideringsFeil('Velg et oppmøtested.', 'stedId');

  return { fornavn, etternavn, epost, telefon, fodselsar, stedId };
}

module.exports = {
  validerPamelding,
  normaliserEpost,
  normaliserTelefon,
  AKSJONSAR,
  MINSTEALDER,
  SISTE_GYLDIGE_FODSELSAR,
};
