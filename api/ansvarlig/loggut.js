'use strict';

const { handler, slettAnsvarligSesjon } = require('../../src/vercel');

module.exports = handler(['POST'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  slettAnsvarligSesjon(res);
  res.status(200).json({ ok: true });
});
