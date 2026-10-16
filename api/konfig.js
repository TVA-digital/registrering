'use strict';

const { handler } = require('../src/vercel');

module.exports = handler(['GET'], async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ personvernUrl: process.env.PRIVACY_URL || 'https://www.tvaksjonen.no/personvern' });
});
