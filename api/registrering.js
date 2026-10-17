'use strict';

const { handler, hentStorage, lesJson, begrens, stedMap } = require('../src/vercel');
const { validerPamelding } = require('../src/validering');
const { maksForBackup, stedForKvittering, tarImotPamelding } = require('../src/hjelpere');
const { AppError } = require('../src/feil');

const MAKS_PER_MINUTT = Number(process.env.MAKS_PER_MINUTT) || 10;

module.exports = handler(['POST'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  await begrens(req, res, 'reg', MAKS_PER_MINUTT);
  const body = lesJson(req);

  // Honningkrukke: usynlig felt som bare roboter fyller ut. Svar "ok" uten å lagre.
  if (typeof body.nettside === 'string' && body.nettside.trim()) {
    console.warn('Honningkrukke utløst, ignorerer innsending');
    return res.status(201).json({ ok: true });
  }

  const reg = validerPamelding(body);
  const sted = stedMap.get(reg.stedId);
  if (!sted || !tarImotPamelding(sted)) {
    throw new AppError('Oppmøtestedet tar ikke imot påmeldinger.', { status: 400, kode: 'ugyldig', felt: 'stedId' });
  }

  const storage = await hentStorage();
  const { id } = await storage.opprett(reg, { maksBackup: maksForBackup(sted), fulltTekst: sted.fulltTekst });
  console.log(`Ny påmelding ${id} til ${sted.id}`);
  res.status(201).json({ ok: true, sted: stedForKvittering(sted) });
});
