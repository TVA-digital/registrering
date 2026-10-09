'use strict';

class AppError extends Error {
  constructor(message, { status = 500, kode = 'intern_feil', felt } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.kode = kode;
    this.felt = felt;
  }
}

class ValideringsFeil extends AppError {
  constructor(message, felt) {
    super(message, { status: 400, kode: 'ugyldig', felt });
  }
}

class EpostBruktFeil extends AppError {
  constructor() {
    super('Denne e-postadressen er allerede registrert. En e-postadresse kan kun brukes én gang.', {
      status: 409,
      kode: 'epost_brukt',
      felt: 'epost',
    });
  }
}

class StedFulltFeil extends AppError {
  constructor(tekst) {
    super(tekst || 'Oppmøtestedet er dessverre fullt. Velg gjerne et annet oppmøtested.', {
      status: 409,
      kode: 'sted_fullt',
      felt: 'stedId',
    });
  }
}

module.exports = { AppError, ValideringsFeil, EpostBruktFeil, StedFulltFeil };
