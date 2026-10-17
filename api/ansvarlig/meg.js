'use strict';

const { handler, krevAnsvarlig, steder } = require('../../src/vercel');
const { stederForAnsvarlig, rolle } = require('../../src/tilgang');
const { formaterTid, adresse } = require('../../src/hjelpere');

module.exports = handler(['GET'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ansvarlig = await krevAnsvarlig(req);
  res.status(200).json({
    epost: ansvarlig.epost,
    navn: ansvarlig.navn,
    rolle: rolle(ansvarlig.tilganger),
    steder: stederForAnsvarlig(ansvarlig.tilganger, steder).map((s) => ({
      id: s.id, navn: s.navn, kommune: s.kommune, fylke: s.fylke, adresse: adresse(s), tid: formaterTid(s.tid),
    })),
  });
});
