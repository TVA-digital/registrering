'use strict';

const crypto = require('node:crypto');
const { handler, lesJson, begrens, verdiNokkel, hentAnsvarligStorage, kodeHash } = require('../../src/vercel');
const { sendKode } = require('../../src/epost');
const { AppError } = require('../../src/feil');

const GYLDIG_SEK = 600;
const SVAR = { ok: true, melding: 'Hvis e-postadressen har tilgang, får du en kode på e-post i løpet av et minutt.' };

module.exports = handler(['POST'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const storage = await hentAnsvarligStorage();
  await begrens(req, res, 'kode-ip', 10, 600, { storage });

  const epost = String(lesJson(req).epost || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(epost) || epost.length > 254) {
    throw new AppError('Skriv inn en gyldig e-postadresse.', { status: 400, kode: 'ugyldig', felt: 'epost' });
  }
  await begrens(req, res, 'kode-epost', 3, 600, { storage, nokkel: verdiNokkel('kode-epost', epost) });

  // Samme svar uansett om adressen finnes, så lista over ansvarlige ikke kan kartlegges.
  const ansvarlig = await storage.hentAnsvarlig(epost);
  if (!ansvarlig) return res.status(200).json(SVAR);

  const kode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await storage.lagKode(epost, kodeHash(epost, kode), GYLDIG_SEK);
  try {
    await sendKode(epost, kode, { navn: (ansvarlig.navn || '').split(' ')[0] });
  } catch (err) {
    console.error('Sending av engangskode feilet:', err);
    throw new AppError('Vi klarte ikke å sende e-post akkurat nå. Prøv igjen om litt.', { status: 503, kode: 'epost_feil' });
  }
  res.status(200).json(SVAR);
});
