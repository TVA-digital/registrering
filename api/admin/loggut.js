'use strict';

const { handler, slettSesjon } = require('../../src/vercel');

module.exports = handler(['POST'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  slettSesjon(res);
  res.status(200).json({ ok: true });
});
