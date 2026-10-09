'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { lagApp } = require('./src/app');
const { lagStorage } = require('./src/storage');

const DATAFIL = process.env.OPPMOTESTEDER_FIL || path.join(__dirname, 'data', 'oppmotesteder.json');

async function start() {
  const data = JSON.parse(fs.readFileSync(DATAFIL, 'utf8'));
  if (!Array.isArray(data.steder) || data.steder.length === 0) {
    throw new Error(`Ingen oppmøtesteder i ${DATAFIL}. Kjør "npm run import -- <eksport.csv>".`);
  }

  const storage = lagStorage();
  await storage.init();

  const adminPassord = process.env.ADMIN_PASSWORD || '';
  if (!adminPassord) console.warn('ADMIN_PASSWORD er ikke satt – /admin og CSV-eksport er deaktivert.');
  else if (adminPassord.length < 12) console.warn('ADMIN_PASSWORD bør være minst 12 tegn.');

  const app = lagApp({
    storage,
    data,
    adminPassord,
    personvernUrl: process.env.PRIVACY_URL || 'https://www.tvaksjonen.no/personvern',
  });

  const port = Number(process.env.PORT) || 8080;
  const server = app.listen(port, () => {
    console.log(
      `Påmelding (backup) kjører på port ${port} – ${data.steder.length} oppmøtesteder, lagring: ${process.env.STORAGE || 'sqlite'}`
    );
  });

  const stopp = (signal) => {
    console.log(`${signal} mottatt, avslutter …`);
    server.close(async () => {
      try {
        await storage.lukk();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', stopp);
  process.on('SIGINT', stopp);
}

start().catch((err) => {
  console.error('Oppstart feilet:', err);
  process.exit(1);
});
