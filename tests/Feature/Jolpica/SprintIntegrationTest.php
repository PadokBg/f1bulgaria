<?php

declare(strict_types=1);

use App\Models\Driver;
use App\Models\Race;
use App\Models\Result;
use App\Models\Season;
use App\Services\Jolpica\ResultSyncService;
use App\Services\Standings\StandingsService;
use Illuminate\Support\Facades\Http;

/**
 * Офлайн integration тест с реални Jolpica fixture отговори за São Paulo GP 2024
 * (кръг 21, спринт уикенд). Изпълнява целия sync flow през истинския
 * JolpicaClient — без мрежа.
 */
function jolpicaFixture(string $name): string
{
    return file_get_contents(base_path("tests/Fixtures/jolpica/{$name}"));
}

beforeEach(function () {
    $this->season = Season::factory()->current()->create(['year' => 2024]);
    $this->race = Race::factory()->create([
        'season_id' => $this->season->id,
        'round' => 21,
        // Пистата от фикстурите — синхронът отказва резултати от друга писта.
        'jolpica_id' => 'interlagos',
        'name' => 'São Paulo Grand Prix',
        'has_sprint' => true,
    ]);

    Http::fake([
        '*/2024/21/results.json*' => Http::response(json_decode(jolpicaFixture('race_results_2024_21.json'), true)),
        '*/2024/21/sprint.json*' => Http::response(json_decode(jolpicaFixture('sprint_results_2024_21.json'), true)),
        '*/2024/21/qualifying.json*' => Http::response(json_decode(jolpicaFixture('qualifying_2024_21.json'), true)),
    ]);
});

it('синхронизира race + sprint резултати от fixture данните', function () {
    $stats = app(ResultSyncService::class)->sync($this->race);

    expect($stats['results'])->toBe(2)
        ->and($stats['sprint'])->toBe(2);

    $verstappen = Driver::where('jolpica_id', 'max_verstappen')->first();
    $norris = Driver::where('jolpica_id', 'norris')->first();

    // Всеки пилот има по 2 реда за това състезание (главно + спринт).
    expect(Result::where('race_id', $this->race->id)->where('driver_id', $verstappen->id)->count())->toBe(2)
        ->and(Result::where('race_id', $this->race->id)->where('driver_id', $norris->id)->count())->toBe(2);
});

it('сумира race + sprint точките правилно за всеки пилот', function () {
    app(ResultSyncService::class)->sync($this->race);

    $verstappen = Driver::where('jolpica_id', 'max_verstappen')->first();
    $norris = Driver::where('jolpica_id', 'norris')->first();

    // Verstappen: 25 (race P1) + 7 (sprint P2) = 32
    expect((float) Result::where('driver_id', $verstappen->id)->sum('points'))->toBe(32.0)
        // Norris: 18 (race P2) + 8 (sprint P1) = 26
        ->and((float) Result::where('driver_id', $norris->id)->sum('points'))->toBe(26.0);
});

it('класирането отразява общия сбор и брои само победи от главни състезания', function () {
    app(ResultSyncService::class)->sync($this->race);

    $standings = app(StandingsService::class)->drivers($this->season);
    $top = $standings->firstWhere('driver.jolpica_id', 'max_verstappen');
    $second = $standings->firstWhere('driver.jolpica_id', 'norris');

    expect($top['points'])->toBe(32.0)
        ->and($top['wins'])->toBe(1)          // спечели главното състезание
        ->and($second['points'])->toBe(26.0)
        ->and($second['wins'])->toBe(0);      // спринт победата НЕ е GP победа
});

it('определя pole от квалификацията', function () {
    app(ResultSyncService::class)->sync($this->race);

    $norris = Driver::where('jolpica_id', 'norris')->first();

    expect($this->race->fresh()->pole_driver_id)->toBe($norris->id);
});
