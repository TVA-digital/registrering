'use strict';

const { handler, hentStorage, krevAdmin, stedMap } = require('../../src/vercel');
const { lagCsv, csvFilnavn } = require('../../src/hjelpere');

module.exports = handler(['GET'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  krevAdmin(req);
  const csv = lagCsv(await (await hentStorage()).alle(), stedMap);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFilnavn()}"`);
  res.status(200).send(csv);
});
