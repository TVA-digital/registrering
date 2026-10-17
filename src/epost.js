'use strict';

/** Sender engangskoder via Resend (https://resend.com). Kan byttes ut i tester med settEpostSender(). */

let overstyrt = null;

function settEpostSender(fn) {
  overstyrt = fn;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function sendKode(epost, kode, { navn = '' } = {}) {
  if (overstyrt) return overstyrt({ epost, kode, navn });

  const nokkel = process.env.RESEND_API_KEY;
  const avsender = process.env.EPOST_AVSENDER;
  if (!nokkel || !avsender) {
    throw new Error('RESEND_API_KEY og EPOST_AVSENDER må være satt for å sende engangskoder.');
  }

  const hilsen = navn ? `Hei ${navn}!` : 'Hei!';
  const tekst = `${hilsen}\n\nDin innloggingskode til nødløsningen for bøssebærere er: ${kode}\n\n` +
    'Koden er gyldig i 10 minutter og kan bare brukes én gang. ' +
    'Har du ikke bedt om denne koden, kan du se bort fra e-posten.\n\nNRK TV-aksjonen';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#000;line-height:1.5">
<p>${escapeHtml(hilsen)}</p>
<p>Din innloggingskode til nødløsningen for bøssebærere er:</p>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#0a2343;margin:16px 0">${kode}</p>
<p>Koden er gyldig i 10 minutter og kan bare brukes én gang. Har du ikke bedt om denne koden, kan du se bort fra e-posten.</p>
<p>NRK TV-aksjonen</p></div>`;

  const kontroller = new AbortController();
  const tidsavbrudd = setTimeout(() => kontroller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${nokkel}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: avsender, to: [epost], subject: `Innloggingskode: ${kode}`, text: tekst, html }),
      signal: kontroller.signal,
    });
    if (!res.ok) {
      const detalj = await res.text().catch(() => '');
      throw new Error(`Resend svarte ${res.status}: ${detalj.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(tidsavbrudd);
  }
}

module.exports = { sendKode, settEpostSender };
