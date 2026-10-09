<?php
/**
 * Innstillinger for backup-påmeldingen.
 *
 * VIKTIG: Bytt admin_passord før siden tas i bruk (minst 12 tegn).
 * Du kan også lime inn en hash fra password_hash() (starter med $2y$) i stedet for klartekst.
 */
return [
    // Passord for admin.html (brukernavn trengs ikke)
    'admin_passord' => 'BYTT-MEG',

    // Lenken i samtykketeksten
    'personvern_url' => 'https://www.tvaksjonen.no/personvern',

    // Brukes til aldersgrensen: man må være født i (aksjonsår - 15) eller tidligere
    'aksjonsar' => 2026,

    // Mappen der databasen og oppmøtestedene ligger. Beskyttet med .htaccess.
    // Har webhotellet en mappe UTENFOR den offentlige webmappen, er det enda tryggere å peke dit.
    'datamappe' => __DIR__ . '/data',

    // Maks antall påmeldinger per minutt fra samme IP-adresse
    'maks_per_minutt' => 10,
];
