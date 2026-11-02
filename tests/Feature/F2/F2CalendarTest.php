<?php

declare(strict_types=1);

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2Race;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use Inertia\Testing\AssertableInertia as Assert;

function seedF2Round(): F2Season
{
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $tsolov = F2Driver::create([
        'f2_season_id' => $season->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov', 'car_number' => 6, 'country_code' => 'BUL',
    ]);
    $race = F2Race::create([
        'f2_season_id' => $season->id, 'circuit_jolpica_id' => 'albert_park',
        'location_name' => 'Melbourne', 'round' => 1, 'slug' => '2026-melbourne',
    ]);
    $feature = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::FeatureRace, 'date' => '2026-03-08']);
    F2Result::create(['f2_race_session_id' => $feature->id, 'f2_driver_id' => $tsolov->id, 'position' => 1, 'points' => 25, 'status' => 'Finished']);

    return $season;
}

it('/f2/calendar показва текущия сезон с кръгове', function () {
    seedF2Round();

    $this->get('/f2/calendar')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('F2/Calendar')
            ->where('season', 2026)
            ->has('rounds', 1)
            ->where('rounds.0.location', 'Melbourne')
            ->where('rounds.0.circuit_jolpica_id', 'albert_park')
            // Име за екрана през DriverName::display — кирилица за slug-овете
            // от config/driver-names-bg.php.
            ->where('rounds.0.feature.podium.0.driver', 'Никола Цолов'));
});

it('/f2/calendar показва второто главно само в кръга, който го има', function () {
    $season = seedF2Round();
    $baku = F2Race::create(['f2_season_id' => $season->id, 'location_name' => 'Baku', 'round' => 12, 'slug' => '2026-baku']);
    $second = F2RaceSession::create(['f2_race_id' => $baku->id, 'session_type' => F2SessionType::SecondFeatureRace, 'date' => '2026-09-26']);
    F2Result::create(['f2_race_session_id' => $second->id, 'f2_driver_id' => F2Driver::query()->value('id'), 'position' => 2, 'points' => 19]);

    $this->get('/f2/calendar')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->has('rounds', 2)
            ->where('rounds.0.feature_2', null)
            ->where('rounds.1.feature_2.date', '26.09.2026')
            ->where('rounds.1.feature_2.podium.0.position', 2));
});

it('/f2/calendar/{year} показва конкретен сезон', function () {
    seedF2Round();
    F2Season::create(['year' => 2025, 'is_current' => false]);

    $this->get('/f2/calendar/2025')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->where('season', 2025)->has('rounds', 0));
});

it('/f2/calendar/{year} за несъществуващ сезон връща 404', function () {
    $this->get('/f2/calendar/1999')->assertNotFound();
});
