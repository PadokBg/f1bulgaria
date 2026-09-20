<?php

declare(strict_types=1);

use App\Models\Driver;
use App\Models\Prediction;
use App\Models\Race;
use App\Models\Season;
use App\Models\User;
use App\Services\LiveTiming\OpenF1Client;
use App\Services\Predictions\LivePredictionService;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;

/*
 * „Падок на живо": докато тече състезанието, прогнозите се точкуват по
 * текущите позиции. Смисълът е прогнозата да спре да бъде формуляр, който
 * попълваш и забравяш до вторник.
 */

beforeEach(function () {
    config(['features.live_predictions' => true]);
    Cache::flush();
});

/**
 * @return array{0: Race, 1: Collection<int, Driver>}
 */
function liveRaceSetup(): array
{
    $season = Season::factory()->create(['is_current' => true]);
    $race = Race::factory()->create(['season_id' => $season->id]);

    $drivers = collect([44, 1, 16, 55])->mapWithKeys(fn (int $number) => [
        $number => Driver::factory()->create([
            'season_id' => $season->id,
            'permanent_number' => $number,
        ]),
    ]);

    return [$race, $drivers];
}

/**
 * @param  array<int, array<string, mixed>>  $positions
 * @param  array<string, mixed>|null  $session
 */
function fakeLivePositions(array $positions, ?array $session = null): void
{
    $session ??= ['key' => 9999, 'type' => 'Race'];

    test()->mock(OpenF1Client::class, function ($mock) use ($positions, $session) {
        $mock->shouldReceive('getLiveSession')->andReturn($session);
        $mock->shouldReceive('getPositions')->andReturn(new Collection($positions));
        $mock->shouldReceive('getSessionDrivers')->andReturn(new Collection);
    });
}

it('мълчи когато няма сесия в ефир', function () {
    [$race] = liveRaceSetup();

    test()->mock(OpenF1Client::class, function ($mock) {
        $mock->shouldReceive('getLiveSession')->andReturn(null);
        $mock->shouldReceive('getPositions')->andReturn(new Collection);
        $mock->shouldReceive('getSessionDrivers')->andReturn(new Collection);
    });

    expect(app(LivePredictionService::class)->standings($race))->toBeNull();
});

it('мълчи по време на квалификация — прогнозите са за състезанието', function () {
    [$race, $drivers] = liveRaceSetup();
    Prediction::factory()->create(['race_id' => $race->id, 'p1_driver_id' => $drivers[44]->id]);

    fakeLivePositions([
        ['driver_number' => 44, 'position' => 1, 'date' => '2026-09-26T13:00:00Z'],
    ], ['key' => 9999, 'type' => 'Qualifying']);

    expect(app(LivePredictionService::class)->standings($race))->toBeNull();
});

it('мълчи когато никой не е прогнозирал', function () {
    [$race] = liveRaceSetup();
    fakeLivePositions([['driver_number' => 44, 'position' => 1, 'date' => '2026-09-26T13:00:00Z']]);

    expect(app(LivePredictionService::class)->standings($race))->toBeNull();
});

it('точкува подиума по текущите позиции', function () {
    [$race, $drivers] = liveRaceSetup();

    $sharp = User::factory()->create(['name' => 'Познал']);
    $wrong = User::factory()->create(['name' => 'Сгрешил']);

    Prediction::factory()->create([
        'race_id' => $race->id,
        'user_id' => $sharp->id,
        'p1_driver_id' => $drivers[44]->id,
        'p2_driver_id' => $drivers[1]->id,
        'p3_driver_id' => $drivers[16]->id,
    ]);
    Prediction::factory()->create([
        'race_id' => $race->id,
        'user_id' => $wrong->id,
        'p1_driver_id' => $drivers[55]->id,
        'p2_driver_id' => $drivers[16]->id,
        'p3_driver_id' => $drivers[1]->id,
    ]);

    fakeLivePositions([
        ['driver_number' => 44, 'position' => 1, 'date' => '2026-09-26T13:40:00Z'],
        ['driver_number' => 1, 'position' => 2, 'date' => '2026-09-26T13:40:00Z'],
        ['driver_number' => 16, 'position' => 3, 'date' => '2026-09-26T13:40:00Z'],
    ]);

    $live = app(LivePredictionService::class)->standings($race);

    expect($live)->not->toBeNull()
        ->and($live['predictors'])->toBe(2)
        ->and($live['standings'][0]['name'])->toBe('Познал')
        ->and($live['standings'][0]['position'])->toBe(1)
        ->and($live['standings'][0]['points'])->toBeGreaterThan($live['standings'][1]['points']);
});

it('взима последната позиция на пилот, не първата', function () {
    // OpenF1 пише ред при ВСЯКА смяна на позиция — подредбата трябва да е по
    // последния запис, иначе панелът показва класирането от старта докрай.
    [$race, $drivers] = liveRaceSetup();

    Prediction::factory()->create([
        'race_id' => $race->id,
        'p1_driver_id' => $drivers[1]->id,
        'p2_driver_id' => $drivers[44]->id,
        'p3_driver_id' => $drivers[16]->id,
    ]);

    fakeLivePositions([
        ['driver_number' => 44, 'position' => 1, 'date' => '2026-09-26T13:00:00Z'],
        ['driver_number' => 1, 'position' => 2, 'date' => '2026-09-26T13:00:00Z'],
        ['driver_number' => 16, 'position' => 3, 'date' => '2026-09-26T13:00:00Z'],
        // Изпреварване: 1 минава пред 44.
        ['driver_number' => 1, 'position' => 1, 'date' => '2026-09-26T13:40:00Z'],
        ['driver_number' => 44, 'position' => 2, 'date' => '2026-09-26T13:40:00Z'],
    ]);

    $live = app(LivePredictionService::class)->standings($race);

    expect($live['podium'][0]['driver_id'])->toBe($drivers[1]->id)
        ->and($live['podium'][1]['driver_id'])->toBe($drivers[44]->id);
});

it('не начислява точки за неизвестните още категории', function () {
    [$race, $drivers] = liveRaceSetup();

    Prediction::factory()->create([
        'race_id' => $race->id,
        'p1_driver_id' => $drivers[44]->id,
        'p2_driver_id' => $drivers[1]->id,
        'p3_driver_id' => $drivers[16]->id,
        'fastest_lap_driver_id' => $drivers[44]->id,
        'dnf_count' => 0,
        'safety_car' => true,
    ]);

    fakeLivePositions([
        ['driver_number' => 44, 'position' => 1, 'date' => '2026-09-26T13:40:00Z'],
        ['driver_number' => 1, 'position' => 2, 'date' => '2026-09-26T13:40:00Z'],
        ['driver_number' => 16, 'position' => 3, 'date' => '2026-09-26T13:40:00Z'],
    ]);

    $breakdown = app(LivePredictionService::class)->standings($race)['standings'][0]['breakdown'];

    expect($breakdown['fastest_lap'])->toBe(0)
        ->and($breakdown['dnf'])->toBe(0)
        ->and($breakdown['safety_car'])->toBe(0);
});

it('рутът е 404 при изключен флаг', function () {
    config(['features.live_predictions' => false]);
    [$race] = liveRaceSetup();

    $this->getJson("/races/{$race->id}/live-predictions")->assertNotFound();
});

it('рутът връща класирането на всеки, без вход', function () {
    [$race, $drivers] = liveRaceSetup();
    Prediction::factory()->create([
        'race_id' => $race->id,
        'p1_driver_id' => $drivers[44]->id,
        'p2_driver_id' => $drivers[1]->id,
        'p3_driver_id' => $drivers[16]->id,
    ]);

    fakeLivePositions([
        ['driver_number' => 44, 'position' => 1, 'date' => '2026-09-26T13:40:00Z'],
        ['driver_number' => 1, 'position' => 2, 'date' => '2026-09-26T13:40:00Z'],
        ['driver_number' => 16, 'position' => 3, 'date' => '2026-09-26T13:40:00Z'],
    ]);

    $this->getJson("/races/{$race->id}/live-predictions")
        ->assertOk()
        ->assertJsonPath('live.predictors', 1)
        ->assertJsonCount(3, 'live.podium');
});
