'use strict';

const { handler, krevAnsvarlig, hentAnsvarligStorage, lesJson, stedMap } = require('../../src/vercel');
const { harTilgang } = require('../../src/tilgang');
const { AppError } = require('../../src/feil');

module.exports = handler(['POST'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ansvarlig = await krevAnsvarlig(req);
  const { personRef, stedId, handling } = lesJson(req);
  if (typeof personRef !== 'string' || !/^(ap|bk):[A-Za-z0-9-]{1,64}$/.test(personRef)) {
    throw new AppError('Ugyldig bøssebærer.', { status: 400, kode: 'ugyldig' });
  }
  if (!['ut', 'inn', 'angre'].includes(handling)) throw new AppError('Ugyldig handling.', { status: 400, kode: 'ugyldig' });
  const sted = stedMap.get(String(stedId || ''));
  if (!sted || !harTilgang(ansvarlig.tilganger, sted)) {
    throw new AppError('Du har ikke tilgang til dette oppmøtestedet.', { status: 403, kode: 'ingen_tilgang' });
  }
  const status = await (await hentAnsvarligStorage()).settStatus(personRef, sted.id, handling, ansvarlig.epost);
  res.status(200).json({ ok: true, ...status });
});
