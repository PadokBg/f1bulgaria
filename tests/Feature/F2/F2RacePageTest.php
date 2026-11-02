<?php

declare(strict_types=1);

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2Race;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use App\Models\F2Team;
use Inertia\Testing\AssertableInertia as Assert;

function seedF2Race(): F2Race
{
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $campos = F2Team::create(['f2_season_id' => $season->id, 'name' => 'Campos Racing', 'slug' => 'campos-racing']);
    $tsolov = F2Driver::create([
        'f2_season_id' => $season->id, 'f2_team_id' => $campos->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov', 'car_number' => 6, 'country_code' => 'BUL',
    ]);
    $race = F2Race::create([
        'f2_season_id' => $season->id, 'circuit_jolpica_id' => 'albert_park',
        'location_name' => 'Melbourne', 'round' => 1, 'slug' => '2026-melbourne',
    ]);
    $feature = F2RaceSession::create([
        'f2_race_id' => $race->id, 'session_type' => F2SessionType::FeatureRace,
        'fastest_lap_driver_id' => $tsolov->id, 'fastest_lap_time' => '1:31.730',
    ]);
    F2Result::create([
        'f2_race_session_id' => $feature->id, 'f2_driver_id' => $tsolov->id, 'position' => 1,
        'grid_position' => 2, 'points' => 25, 'status' => 'Finished', 'fastest_lap' => true,
    ]);
    F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::SprintRace]);

    return $race;
}

it('/f2/races/{race}/feature показва резултатите с Цолов', function () {
    seedF2Race();

    $this->get('/f2/races/2026-melbourne/feature')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('F2/RaceShow')
            ->where('race.location', 'Melbourne')
            ->where('sessionType', 'feature')
            ->where('sessionLabel', 'Главно състезание')
            // Toggle-ът е списък от сесиите в реда на уикенда, а не два
            // булеви флага. Показват се само сесии С резултати: синхронът
            // създава редове и за бъдещите кръгове, а линк към празна
            // класация е мъртъв клик. Спринтът тук е без резултати.
            ->has('sessions', 1)
            ->where('sessions.0.segment', 'feature')
            // Имената за екрана минават през DriverName::display — кирилица за
            // slug-овете от config/driver-names-bg.php.
            ->where('results.0.driver', 'Никола Цолов')
            ->where('results.0.position', 1)
            ->where('results.0.is_bulgarian', true)
            ->where('fastestLap.driver', 'Никола Цолов'));
});

it('/f2/races/{race}/feature-2 показва второто главно състезание след първото', function () {
    $race = seedF2Race();
    $second = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::SecondFeatureRace]);
    F2Result::create([
        'f2_race_session_id' => $second->id, 'f2_driver_id' => F2Driver::query()->value('id'),
        'position' => 2, 'points' => 19, 'status' => 'Finished',
    ]);

    $this->get('/f2/races/2026-melbourne/feature-2')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('sessionType', 'feature-2')
            ->where('sessionLabel', 'Второ главно състезание')
            ->where('isRace', true)
            ->has('sessions', 2)
            ->where('sessions.0.segment', 'feature')
            ->where('sessions.1.segment', 'feature-2')
            ->where('results.0.position', 2));
});

it('нарича квалификациите 1 и 2, а не групи, в кръг с второ главно', function (bool $hasSecondFeature, string $first, string $second) {
    $race = seedF2Race();
    $driverId = F2Driver::query()->value('id');
    $types = [F2SessionType::QualifyingGroupA, F2SessionType::QualifyingGroupB];

    if ($hasSecondFeature) {
        $types[] = F2SessionType::SecondFeatureRace;
    }

    foreach ($types as $type) {
        $session = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => $type]);
        F2Result::create(['f2_race_session_id' => $session->id, 'f2_driver_id' => $driverId, 'position' => 1]);
    }

    $this->get('/f2/races/2026-melbourne/qualifying-a')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('sessionLabel', $first)
            ->where('sessions.0.label', $first)
            ->where('sessions.1.label', $second));
})->with([
    // Баку 2026: две квалификации за целия старт, втората нарежда второто главно.
    'Баку' => [true, 'Квалификация 1', 'Квалификация 2'],
    // Монако: наистина две групи по половин старт.
    'Монако' => [false, 'Квалификация, група А', 'Квалификация, група Б'],
]);

it('връща 404 при несъществуваща сесия', function () {
    $season = F2Season::create(['year' => 2026]);
    F2Race::create(['f2_season_id' => $season->id, 'location_name' => 'X', 'round' => 1, 'slug' => '2026-x']);

    // race съществува, но без feature сесия
    $this->get('/f2/races/2026-x/feature')->assertNotFound();
});

it('връща 404 при несъществуващ race', function () {
    $this->get('/f2/races/nope/sprint')->assertNotFound();
});
