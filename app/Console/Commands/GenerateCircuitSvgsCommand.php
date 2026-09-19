<?php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;

/**
 * Генерира SVG outline-и на пистите от bacinger/f1-circuits (MIT, GeoJSON),
 * проектирани към viewBox + вграден анимиран болид (SMIL animateMotion).
 *
 * Ключовете в MAP са Jolpica circuitId (== circuit_slug, по който hero-то
 * търси SVG), НЕ "приятелски" имена. Така генерираните файлове се намират.
 */
class GenerateCircuitSvgsCommand extends Command
{
    protected $signature = 'circuits:generate-svgs
        {--source= : Път до geojson (по подразбиране storage/app/bacinger-circuits.geojson, сваля се при липса)}
        {--output= : Изходна директория (по подразбиране resources/svg/circuits)}
        {--force : Презаписва вече съществуващите SVG файлове}';

    protected $description = 'Генерира SVG outline-и на пистите от bacinger/f1-circuits GeoJSON.';

    private const GEOJSON_URL = 'https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson';

    /**
     * circuit_slug (Jolpica circuitId) => bacinger GeoJSON feature id.
     *
     * @var array<string, string>
     */
    private const MAP = [
        'bahrain' => 'bh-2002',
        'jeddah' => 'sa-2021',
        'baku' => 'az-2016',
        'albert_park' => 'au-1953',
        'suzuka' => 'jp-1962',
        'shanghai' => 'cn-2004',
        'miami' => 'us-2022',
        'imola' => 'it-1953',
        'monaco' => 'mc-1929',
        'villeneuve' => 'ca-1978',
        'catalunya' => 'es-1991',
        'red_bull_ring' => 'at-1969',
        'silverstone' => 'gb-1948',
        'hungaroring' => 'hu-1986',
        'spa' => 'be-1925',
        'zandvoort' => 'nl-1948',
        'monza' => 'it-1922',
        'marina_bay' => 'sg-2008',
        'americas' => 'us-2012',
        'rodriguez' => 'mx-1962',
        'interlagos' => 'br-1940',
        'losail' => 'qa-2004',
        'yas_marina' => 'ae-2009',
        'vegas' => 'us-2023',
        'madring' => 'es-2026',
    ];

    public function handle(): int
    {
        $source = $this->option('source') ?: storage_path('app/bacinger-circuits.geojson');
        $output = $this->option('output') ?: resource_path('svg/circuits');

        if (! is_dir($output)) {
            mkdir($output, 0755, true);
        }

        try {
            $features = $this->loadFeatures($source);
        } catch (\Throwable $e) {
            $this->error("Неуспешно зареждане на GeoJSON: {$e->getMessage()}");

            return self::FAILURE;
        }

        $created = [];
        $skipped = [];
        $missing = [];

        foreach (self::MAP as $slug => $featureId) {
            $path = "{$output}/{$slug}.svg";

            if (file_exists($path) && ! $this->option('force')) {
                $skipped[] = $slug;

                continue;
            }

            if (! isset($features[$featureId])) {
                $missing[] = $slug;

                continue;
            }

            file_put_contents($path, $this->buildSvg($slug, $features[$featureId]));
            $created[] = $slug;
        }

        $this->info('Създадени: '.(count($created) ? implode(', ', $created) : '0'));
        $this->line('Пропуснати (вече съществуват): '.count($skipped));

        // Hero-то показва името на пистата вместо анимация, ако SVG липсва.
        if ($missing !== []) {
            $this->warn('Липсват в GeoJSON (ще ползват fallback): '.implode(', ', $missing));
        }

        return self::SUCCESS;
    }

    /**
     * @return array<string, array<string, mixed>> features индексирани по id
     */
    private function loadFeatures(string $source): array
    {
        if (! file_exists($source)) {
            $this->line('Свалям GeoJSON от bacinger...');
            $body = Http::timeout(30)->retry(2, 500)->get(self::GEOJSON_URL)->throw()->body();
            file_put_contents($source, $body);
        }

        $geo = json_decode((string) file_get_contents($source), true, 512, JSON_THROW_ON_ERROR);

        $byId = [];
        foreach ($geo['features'] ?? [] as $f) {
            $byId[$f['properties']['id']] = $f;
        }

        return $byId;
    }

    /**
     * @param  array<string, mixed>  $feature
     */
    private function buildSvg(string $slug, array $feature): string
    {
        $coords = $this->longestLine($feature['geometry']);

        $lats = array_map(fn ($c) => $c[1], $coords);
        $k = cos(deg2rad((min($lats) + max($lats)) / 2)); // корекция дължина/ширина

        $pts = array_map(fn ($c) => [$c[0] * $k, $c[1]], $coords);
        $xs = array_map(fn ($p) => $p[0], $pts);
        $ys = array_map(fn ($p) => $p[1], $pts);
        [$minX, $maxX, $minY, $maxY] = [min($xs), max($xs), min($ys), max($ys)];
        $rangeX = max($maxX - $minX, 1e-9);
        $rangeY = max($maxY - $minY, 1e-9);

        $pad = 40.0;
        $scale = (1000.0 - 2 * $pad) / max($rangeX, $rangeY);
        $w = round($rangeX * $scale + 2 * $pad, 1);
        $h = round($rangeY * $scale + 2 * $pad, 1);

        $d = '';
        foreach ($pts as $i => $p) {
            $x = round($pad + ($p[0] - $minX) * $scale, 1);
            $y = round($pad + ($maxY - $p[1]) * $scale, 1); // флип на Y
            $d .= ($i === 0 ? 'M' : 'L')."{$x} {$y} ";
        }
        $d = trim($d).' Z';

        $sw = round(max($w, $h) / 110, 1);
        $id = "track-{$slug}";

        // Болидът се движи по CSS motion-path (offset-path) — рестартира се
        // автоматично при mount/remount (Inertia SPA), за разлика от SMIL.
        // Кадрите (@keyframes f1-track-dot) са в resources/css/app.css.
        $dotStyle = "offset-path: path('{$d}'); offset-rotate: auto; animation: f1-track-dot 14s linear infinite;";

        return <<<SVG
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {$w} {$h}" fill="none" data-circuit="{$slug}">
              <path id="{$id}" d="{$d}" stroke="currentColor" stroke-width="{$sw}" stroke-linejoin="round" stroke-linecap="round" />
              <circle r="{$sw}" fill="#e10600" style="{$dotStyle}"></circle>
            </svg>

            SVG;
    }

    /**
     * @param  array<string, mixed>  $geometry
     * @return array<int, array{0: float, 1: float}>
     */
    private function longestLine(array $geometry): array
    {
        if ($geometry['type'] === 'LineString') {
            return $geometry['coordinates'];
        }

        $best = [];
        foreach ($geometry['coordinates'] as $line) {
            if (count($line) > count($best)) {
                $best = $line;
            }
        }

        return $best;
    }
}
