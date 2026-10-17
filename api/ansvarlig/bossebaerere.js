'use strict';

const { handler, krevAnsvarlig, hentAnsvarligStorage, stedMap } = require('../../src/vercel');
const { harTilgang } = require('../../src/tilgang');
const { AppError } = require('../../src/feil');

module.exports = handler(['GET'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ansvarlig = await krevAnsvarlig(req);
  const stedId = String(req.query?.sted || '');
  const sted = stedMap.get(stedId);
  if (!sted) throw new AppError('Fant ikke oppmøtestedet.', { status: 404, kode: 'ikke_funnet' });
  if (!harTilgang(ansvarlig.tilganger, sted)) {
    throw new AppError('Du har ikke tilgang til dette oppmøtestedet.', { status: 403, kode: 'ingen_tilgang' });
  }
  const bossebaerere = await (await hentAnsvarligStorage()).bossebaerere(stedId);
  res.status(200).json({ stedId, hentet: new Date().toISOString(), bossebaerere });
});
