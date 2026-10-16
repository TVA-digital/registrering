'use strict';

const { handler, hentStorage, steder } = require('../src/vercel');
const { stederForApi } = require('../src/hjelpere');

module.exports = handler(['GET'], async (req, res) => {
  let antall = new Map();
  try {
    antall = await (await hentStorage()).antallPerSted();
  } catch (err) {
    // Listen vises uansett; kapasitet sjekkes på nytt når noen melder seg på.
    console.error('Klarte ikke hente antall påmeldte:', err);
  }
  // Vercels CDN cacher svaret i 15 sekunder, så databasen ikke belastes ved stor pågang.
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.setHeader('CDN-Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30');
  res.status(200).json(stederForApi(steder, antall));
});
