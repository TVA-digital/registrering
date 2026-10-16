'use strict';

const { handler, hentStorage, krevAdmin, stedMap } = require('../../src/vercel');
const { oppsummering } = require('../../src/hjelpere');

module.exports = handler(['GET'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  krevAdmin(req);
  const antall = await (await hentStorage()).antallPerSted();
  res.status(200).json({ ...oppsummering(antall, stedMap), sistePamelding: null });
});
