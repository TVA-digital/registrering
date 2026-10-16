'use strict';

const { handler, lesJson, begrens, adminPassord, likt, settSesjon } = require('../../src/vercel');
const { AppError } = require('../../src/feil');

module.exports = handler(['POST'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const riktig = adminPassord();
  await begrens(req, res, 'login', 5);
  const { passord } = lesJson(req);
  if (typeof passord !== 'string' || !likt(passord, riktig)) {
    throw new AppError('Feil passord.', { status: 401, kode: 'feil_passord' });
  }
  settSesjon(res);
  res.status(200).json({ ok: true });
});
