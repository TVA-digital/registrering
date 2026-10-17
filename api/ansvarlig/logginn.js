'use strict';

const { handler, lesJson, begrens, hentAnsvarligStorage, kodeHash, settAnsvarligSesjon } = require('../../src/vercel');
const { AppError } = require('../../src/feil');

module.exports = handler(['POST'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const storage = await hentAnsvarligStorage();
  await begrens(req, res, 'logginn-ip', 20, 600, { storage });

  const body = lesJson(req);
  const epost = String(body.epost || '').trim().toLowerCase();
  const kode = String(body.kode || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(kode) || !epost) {
    throw new AppError('Skriv inn den 6-sifrede koden fra e-posten.', { status: 400, kode: 'ugyldig', felt: 'kode' });
  }
  if (!(await storage.brukKode(epost, kodeHash(epost, kode)))) {
    throw new AppError('Koden er feil eller utløpt. Be om en ny kode hvis du har prøvd flere ganger.', { status: 401, kode: 'feil_kode', felt: 'kode' });
  }
  settAnsvarligSesjon(res, epost);
  res.status(200).json({ ok: true });
});
