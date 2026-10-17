'use strict';

/**
 * Regner ut hvilke oppmøtesteder en ansvarlig har tilgang til.
 * tilganger: 'sted:<id>', 'kommune:<kommune>', 'kommune:<fylke>/<kommune>', 'fylke:<fylke>', 'nasjonal'
 */

const norm = (s) => String(s || '').trim().toLocaleLowerCase('nb');

function lagSjekk(tilganger) {
  const steder = new Set();
  const kommuner = [];
  const fylker = new Set();
  let nasjonal = false;
  for (const t of tilganger || []) {
    const i = t.indexOf(':');
    const type = i === -1 ? t : t.slice(0, i);
    const verdi = i === -1 ? '' : t.slice(i + 1);
    if (type === 'nasjonal') nasjonal = true;
    else if (type === 'sted') steder.add(verdi);
    else if (type === 'fylke') fylker.add(norm(verdi));
    else if (type === 'kommune') {
      const [a, b] = verdi.split('/');
      kommuner.push(b === undefined ? { kommune: norm(a) } : { fylke: norm(a), kommune: norm(b) });
    }
  }
  return (s) =>
    nasjonal ||
    steder.has(s.id) ||
    fylker.has(norm(s.fylke)) ||
    kommuner.some((k) => k.kommune === norm(s.kommune) && (!k.fylke || k.fylke === norm(s.fylke)));
}

/** Oppmøtestedene den ansvarlige kan se, sortert på fylke, kommune og navn. */
function stederForAnsvarlig(tilganger, steder) {
  const sjekk = lagSjekk(tilganger);
  const collator = new Intl.Collator('nb');
  return steder
    .filter(sjekk)
    .sort((a, b) => collator.compare(a.fylke, b.fylke) || collator.compare(a.kommune, b.kommune) || collator.compare(a.navn, b.navn));
}

function harTilgang(tilganger, sted) {
  return Boolean(sted) && lagSjekk(tilganger)(sted);
}

/** Visningsnavn for rollen (den bredeste tilgangen). */
function rolle(tilganger) {
  const t = tilganger || [];
  if (t.includes('nasjonal')) return 'Nasjonal';
  if (t.some((x) => x.startsWith('fylke:'))) return 'Fylke';
  if (t.some((x) => x.startsWith('kommune:'))) return 'Kommune';
  return 'Oppmøtested';
}

module.exports = { stederForAnsvarlig, harTilgang, rolle };
