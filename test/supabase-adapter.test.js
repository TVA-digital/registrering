'use strict';

// Tester feiltolkning og blaing i SupabaseStorage med en falsk klient (ingen nettverk).
const test = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseStorage } = require('../src/storage/supabase');
const { EpostBruktFeil, StedFulltFeil } = require('../src/feil');

function lagStorage(db) {
  const s = new SupabaseStorage({ url: 'https://x.supabase.co', nokkel: 'k' });
  s.db = db;
  return s;
}

const reg = { fornavn: 'A', etternavn: 'B', epost: 'a@b.no', telefon: '12345678', fodselsar: 1990, stedId: 's1' };

test('oversetter databasefeil til riktige feiltyper', async () => {
  const med = (error) => lagStorage({ rpc: async () => ({ data: null, error }) });
  await assert.rejects(med({ code: 'P0001', message: 'EPOST_BRUKT' }).opprett(reg), EpostBruktFeil);
  await assert.rejects(med({ code: 'P0001', message: 'STED_FULLT' }).opprett(reg, { fulltTekst: 'Fullt her' }),
    (e) => e instanceof StedFulltFeil && e.message === 'Fullt her');
  await assert.rejects(med({ code: '57014', message: 'timeout' }).opprett(reg), /Supabase \(registrer_pamelding\): timeout/);
});

test('sender riktige parametre og leser svar', async () => {
  let kalt;
  const s = lagStorage({
    rpc: async (navn, args) => {
      kalt = { navn, args };
      if (navn === 'antall_per_sted') return { data: [{ sted_id: 's1', antall: 3 }, { sted_id: 's2', antall: '2' }], error: null };
      return { data: { id: 'uuid', opprettet: '2026-10-16T10:00:00Z' }, error: null };
    },
  });
  assert.deepEqual(await s.opprett(reg, { maksBackup: 5 }), { id: 'uuid', opprettet: '2026-10-16T10:00:00Z' });
  assert.equal(kalt.args.p_maks, 5);
  assert.equal(kalt.args.p_sted_id, 's1');
  assert.deepEqual([...await s.antallPerSted()], [['s1', 3], ['s2', 2]]);
});

test('alle() blar gjennom mer enn 1000 rader', async () => {
  const totalt = 2345;
  const rader = Array.from({ length: totalt }, (_, i) => ({
    id: String(i), opprettet: 't', fornavn: 'A', etternavn: 'B', epost: `${i}@x.no`, telefon: '1',
    fodselsar: '1990', sted_id: 's', samtykke: true,
  }));
  const s = lagStorage({
    from: () => {
      const q = { select: () => q, order: () => q, range: async (fra, til) => ({ data: rader.slice(fra, til + 1), error: null }) };
      return q;
    },
  });
  const alle = await s.alle();
  assert.equal(alle.length, totalt);
  assert.equal(alle[2344].epost, '2344@x.no');
  assert.equal(alle[0].fodselsar, 1990);
  assert.equal(alle[0].stedId, 's');
});
