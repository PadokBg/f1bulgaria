<?php

declare(strict_types=1);

use Illuminate\Support\Facades\File;

function fixtureGeojson(string $dir): string
{
    $source = "{$dir}/source.geojson";
    file_put_contents($source, json_encode([
        'type' => 'FeatureCollection',
        'features' => [[
            'type' => 'Feature',
            'properties' => ['id' => 'es-1991', 'Name' => 'Circuit de Barcelona-Catalunya'],
            'geometry' => [
                'type' => 'LineString',
                'coordinates' => [[2.20, 41.57], [2.26, 41.57], [2.26, 41.58], [2.20, 41.58], [2.20, 41.57]],
            ],
        ]],
    ]));

    return $source;
}

it('генерира валиден SVG с path и анимиран болид', function () {
    $dir = storage_path('app/testing/circuits-'.uniqid());
    File::ensureDirectoryExists($dir.'/out');
    $source = fixtureGeojson($dir);

    $this->artisan('circuits:generate-svgs', ['--source' => $source, '--output' => "{$dir}/out"])
        ->assertSuccessful();

    $svg = File::get("{$dir}/out/catalunya.svg");

    expect($svg)->toContain('<svg')
        ->and($svg)->toContain('<path')
        ->and($svg)->toContain('id="track-catalunya"')
        ->and($svg)->toContain('offset-path')          // CSS motion-path вместо SMIL
        ->and($svg)->toContain('f1-track-dot')
        ->and($svg)->toContain('viewBox');

    File::deleteDirectory($dir);
});

it('не презаписва вече съществуващ SVG', function () {
    $dir = storage_path('app/testing/circuits-'.uniqid());
    File::ensureDirectoryExists($dir.'/out');
    $source = fixtureGeojson($dir);

    file_put_contents("{$dir}/out/catalunya.svg", 'ORIGINAL');

    $this->artisan('circuits:generate-svgs', ['--source' => $source, '--output' => "{$dir}/out"])
        ->assertSuccessful();

    expect(File::get("{$dir}/out/catalunya.svg"))->toBe('ORIGINAL'); // непокътнат

    File::deleteDirectory($dir);
});

it('има контур за всяка писта от календара — hero-то не пада на името', function () {
    // Пистите на играта са календарът на сезона (Jolpica circuitId), а
    // hero-то търси resources/svg/circuits/{circuit_slug}.svg. Баку и Лас
    // Вегас бяха изключени по стар списък, макар bacinger вече да ги има.
    $missing = collect(array_keys(config('game.tracks')))
        ->reject(fn (string $slug): bool => File::exists(resource_path("svg/circuits/{$slug}.svg")))
        ->values()
        ->all();

    expect($missing)->toBe([]);
});
