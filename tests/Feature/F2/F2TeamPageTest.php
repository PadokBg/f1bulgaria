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

function seedCampos(): void
{
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $team = F2Team::create(['f2_season_id' => $season->id, 'name' => 'Campos Racing', 'slug' => 'campos-racing']);
    $tsolov = F2Driver::create([
        'f2_season_id' => $season->id, 'f2_team_id' => $team->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov', 'country_code' => 'BUL', 'points' => 120,
    ]);
    $race = F2Race::create(['f2_season_id' => $season->id, 'location_name' => 'Melbourne', 'round' => 1, 'slug' => '2026-melbourne']);
    $feature = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::FeatureRace]);
    F2Result::create(['f2_race_session_id' => $feature->id, 'f2_driver_id' => $tsolov->id, 'position' => 1, 'points' => 25]);
}

it('/f2/teams показва отборите от текущия сезон', function () {
    seedCampos();

    $this->get('/f2/teams')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('F2/TeamIndex')
            ->where('season', 2026)
            ->where('teams.0.name', 'Campos Racing')
            ->where('teams.0.points', 120));
});

it('/f2/teams/{slug} показва Campos с Цолов', function () {
    seedCampos();

    $this->get('/f2/teams/campos-racing')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('F2/TeamShow')
            ->where('team.name', 'Campos Racing')
            ->where('stats.wins', 1)
            // Име на пилота за екрана през DriverName::display — кирилица.
            // Името на отбора (`team.name`) НЕ се локализира.
            ->where('currentDrivers.0.name', 'Никола Цолов')
            ->where('currentDrivers.0.is_bulgarian', true)
            ->has('alumni', 1));
});

it('/f2/teams/{slug} не брои P1 от тренировка за победа', function () {
    seedCampos();
    $practice = F2RaceSession::create(['f2_race_id' => F2Race::query()->value('id'), 'session_type' => F2SessionType::Practice]);
    F2Result::create(['f2_race_session_id' => $practice->id, 'f2_driver_id' => F2Driver::query()->value('id'), 'position' => 1]);

    $this->get('/f2/teams/campos-racing')
        ->assertInertia(fn (Assert $page) => $page
            ->where('stats.wins', 1)
            ->where('stats.podiums', 1));
});

it('връща 404 за несъществуващ F2 отбор', function () {
    $this->get('/f2/teams/nonexistent')->assertNotFound();
});
