<?php
/**
 * Sjekker at webhotellet støtter backup-påmeldingen.
 * Åpne sjekk.php i nettleseren etter opplasting. SLETT fila når alt er grønt.
 */
declare(strict_types=1);
header('Content-Type: text/html; charset=utf-8');
header('X-Robots-Tag: noindex');

$k = @include __DIR__ . '/config.php';
$mappe = is_array($k) ? rtrim((string) $k['datamappe'], '/\\') : __DIR__ . '/data';
$resultater = [];
// $bestatt: true = ok, false = feil, null = må sjekkes manuelt. $hjelp vises bare når det ikke er ok.
$ok = function (string $navn, ?bool $bestatt, string $hjelp = '', string $info = '') use (&$resultater) {
    $resultater[] = [$navn, $bestatt, $bestatt === true ? $info : trim($info . ' ' . $hjelp)];
};

$ok('PHP-versjon 7.4 eller nyere', version_compare(PHP_VERSION, '7.4.0', '>='), '', 'Har ' . PHP_VERSION);
$ok('PDO SQLite er installert', extension_loaded('pdo_sqlite'), 'Be webhotellet aktivere pdo_sqlite hvis denne er rød');
$ok('mbstring er installert', extension_loaded('mbstring'));
$ok('config.php kan leses', is_array($k));
$passord = is_array($k) ? (string) ($k['admin_passord'] ?? '') : '';
$ok('Admin-passord er byttet', $passord !== 'BYTT-MEG' && (strpos($passord, '$2y$') === 0 || strlen($passord) >= 12),
    'Endre admin_passord i config.php til minst 12 tegn');
$ok('Oppmøtesteder finnes', is_file($mappe . '/oppmotesteder.json'));

$skrivbar = false;
if (is_dir($mappe)) {
    $test = $mappe . '/.skrivetest';
    $skrivbar = @file_put_contents($test, 'ok') !== false;
    @unlink($test);
}
$ok('Datamappen er skrivbar', $skrivbar, 'Gi webserveren skrivetilgang til ' . $mappe);

if (extension_loaded('pdo_sqlite') && $skrivbar) {
    try {
        $pdo = new PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE t (a TEXT UNIQUE); BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT;');
        $ok('SQLite fungerer', true);
    } catch (Throwable $e) {
        $ok('SQLite fungerer', false, $e->getMessage());
    }
}

// Sjekk at datamappen IKKE kan lastes ned fra nettet (krever at .htaccess virker)
$https = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
$base = ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . rtrim(dirname($_SERVER['SCRIPT_NAME']), '/');
$beskyttet = null;
if (realpath($mappe) === realpath(__DIR__ . '/data') && ini_get('allow_url_fopen')) {
    $ctx = stream_context_create(['http' => ['method' => 'HEAD', 'timeout' => 5, 'ignore_errors' => true]]);
    $headers = @get_headers($base . '/data/oppmotesteder.json', false, $ctx);
    if ($headers) {
        $beskyttet = !preg_match('#\s200\s#', $headers[0]);
    }
}
if ($beskyttet === null) {
    $ok('Datamappen er sperret for nedlasting', null,
        "Kunne ikke teste automatisk. Åpne $base/data/oppmotesteder.json selv – du skal få «Forbidden»/403, ikke se innholdet.");
} else {
    $ok('Datamappen er sperret for nedlasting', $beskyttet,
        $beskyttet ? '' : 'Serveren ser ikke ut til å bruke .htaccess (nginx?). Be webhotellet sperre data-mappen, eller flytt den utenfor webmappen via config.php.');
}

$status = array_column($resultater, 1);
$alleOk = !in_array(false, $status, true);
$manuelt = in_array(null, $status, true);
?><!doctype html>
<html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sjekk av webhotell</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;background:#f7f4f2;color:#000;margin:0;line-height:1.5}
main{max-width:720px;margin:0 auto;padding:32px 16px}h1{color:#0a2343}
li{background:#fff;border-radius:8px;padding:12px 16px;margin:0 0 8px;list-style:none;box-shadow:0 2px 8px rgba(0,0,0,.08)}
ul{padding:0}.ok b::before{content:"✔ ";color:#004952}.ikke b::before{content:"✘ ";color:#990D40}
small{display:block;color:#333}.status{padding:16px;border-radius:8px;font-weight:700}
.manuelt b::before{content:"! ";color:#000}
.gronn{background:#D0F5D9}.rod{background:#FFC7BD}.gul{background:#FCE6BD}
</style></head><body><main>
<h1>Sjekk av webhotell</h1>
<p class="status <?= !$alleOk ? 'rod' : ($manuelt ? 'gul' : 'gronn') ?>"><?= !$alleOk
    ? 'Noe må fikses før løsningen kan brukes – se de røde punktene.'
    : ($manuelt ? 'Nesten klart! Sjekk det gule punktet selv, test påmeldingen på index.html og slett deretter sjekk.php.'
                : 'Alt ser bra ut! Test påmeldingen på index.html, og slett deretter sjekk.php.') ?></p>
<ul>
<?php foreach ($resultater as [$navn, $bestatt, $info]): ?>
  <li class="<?= $bestatt === null ? 'manuelt' : ($bestatt ? 'ok' : 'ikke') ?>"><b><?= htmlspecialchars($navn) ?></b>
  <?php if ($info !== ''): ?><small><?= htmlspecialchars($info) ?></small><?php endif; ?></li>
<?php endforeach; ?>
</ul>
</main></body></html>
