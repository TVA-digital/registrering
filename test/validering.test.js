'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validerPamelding, normaliserTelefon } = require('../src/validering');

const gyldig = {
  fornavn: ' Kari ',
  etternavn: 'Nordmann-Olsen',
  epost: ' Kari@Example.NO ',
  telefon: '+47 912 34 567',
  fodselsar: '1990',
  samtykke: true,
  stedId: '66def8b02e9b604e331d8e6a',
};

test('normaliserer gyldig påmelding', () => {
  assert.deepEqual(validerPamelding(gyldig), {
    fornavn: 'Kari',
    etternavn: 'Nordmann-Olsen',
    epost: 'kari@example.no',
    telefon: '91234567',
    fodselsar: 1990,
    stedId: '66def8b02e9b604e331d8e6a',
  });
});

test('aldersgrense: født 2011 er ok, 2012 avvises', () => {
  assert.equal(validerPamelding({ ...gyldig, fodselsar: '2011' }).fodselsar, 2011);
  assert.throws(() => validerPamelding({ ...gyldig, fodselsar: '2012' }), { felt: 'fodselsar' });
});

test('avviser manglende samtykke, ugyldig e-post og tomme felt', () => {
  assert.throws(() => validerPamelding({ ...gyldig, samtykke: 'true' }), { felt: 'samtykke' });
  assert.throws(() => validerPamelding({ ...gyldig, epost: 'kari@example' }), { felt: 'epost' });
  assert.throws(() => validerPamelding({ ...gyldig, fornavn: '   ' }), { felt: 'fornavn' });
  assert.throws(() => validerPamelding({ ...gyldig, fornavn: '<script>' }), { felt: 'fornavn' });
  assert.throws(() => validerPamelding(null), { status: 400 });
});

test('telefonnummer', () => {
  assert.equal(normaliserTelefon('912 34 567'), '91234567');
  assert.equal(normaliserTelefon('0047 91234567'), '91234567');
  assert.equal(normaliserTelefon('+46 701234567'), '+46701234567');
  assert.equal(normaliserTelefon('1234'), null);
});
