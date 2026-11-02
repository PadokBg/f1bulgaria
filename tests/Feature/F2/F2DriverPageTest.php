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

function seedTsolovCareer(): void
{
    foreach ([2025, 2026] as $year) {
        $season = F2Season::create(['year' => $year, 'is_current' => $year === 2026]);
        $team = F2Team::create(['f2_season_id' => $season->id, 'name' => 'Campos Racing', 'slug' => 'campos-racing']);
        $driver = F2Driver::create([
            'f2_season_id' => $season->id, 'f2_team_id' => $team->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
            'slug' => 'nikola-tsolov', 'car_number' => 6, 'country_code' => 'BUL', 'points' => 100, 'position' => 2,
        ]);
        $race = F2Race::create(['f2_season_id' => $season->id, 'location_name' => 'Melbourne', 'round' => 1, 'slug' => "{$year}-melbourne", 'circuit_jolpica_id' => 'albert_park']);
        $feature = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::FeatureRace, 'pole_position_driver_id' => $driver->id]);
        F2Result::create(['f2_race_session_id' => $feature->id, 'f2_driver_id' => $driver->id, 'position' => 1, 'points' => 25, 'status' => 'Finished']);
    }
}

it('/f2/drivers показва пилотите от текущия сезон', function () {
    seedTsolovCareer();

    $this->get('/f2/drivers')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('F2/DriverIndex')
            ->where('season', 2026)
            // Име за екрана през DriverName::display — кирилица за slug-овете
            // от config/driver-names-bg.php. Slug-ът в URL-а остава латински.
            ->where('drivers.0.name', 'Никола Цолов')
            ->where('drivers.0.is_bulgarian', true));
});

it('/f2/drivers/{slug} агрегира кариерата през сезоните', function () {
    seedTsolovCareer();

    $this->get('/f2/drivers/nikola-tsolov')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('F2/DriverShow')
            // Кирилско име за екрана — виж бележката в теста по-горе.
            ->where('driver.name', 'Никола Цолов')
            ->where('driver.is_bulgarian', true)
            ->where('stats.seasons', 2)
            ->where('stats.starts', 2)   // 1 резултат × 2 сезона
            ->where('stats.wins', 2)
            ->where('stats.poles', 2)
            ->has('seasons', 2)
            ->has('recentResults'));
});

it('брои само състезанията за стартове, победи и подиуми, а pole-а веднъж', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $driver = F2Driver::create([
        'f2_season_id' => $season->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov', 'country_code' => 'BUL',
    ]);
    $race = F2Race::create(['f2_season_id' => $season->id, 'location_name' => 'Spa-Francorchamps', 'round' => 8, 'slug' => '2026-spa-francorchamps']);

    // P1 в тренировката и квалификацията не е победа, нито старт. Pole-ът
    // стои и върху квалификацията, и върху главното (F2ApiSync::propagatePole).
    // Второто главно (Баку 2026) е старт и има свой pole.
    $sessions = [
        'practice' => ['position' => 1, 'pole' => false],
        'qualifying' => ['position' => 1, 'pole' => true],
        'sprint_race' => ['position' => 3, 'pole' => false],
        'feature_race' => ['position' => 1, 'pole' => true],
        'feature_race_2' => ['position' => 5, 'pole' => true],
    ];

    foreach ($sessions as $type => $row) {
        $session = F2RaceSession::create([
            'f2_race_id' => $race->id,
            'session_type' => $type,
            'pole_position_driver_id' => $row['pole'] ? $driver->id : null,
        ]);
        F2Result::create(['f2_race_session_id' => $session->id, 'f2_driver_id' => $driver->id, 'position' => $row['position']]);
    }

    $this->get('/f2/drivers/nikola-tsolov')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('stats.starts', 3)
            ->where('stats.wins', 1)
            ->where('stats.podiums', 2)
            ->where('stats.poles', 2)
            // Линкът води към класацията на самата сесия, не към спринта, а в
            // рамките на кръга редът е от последната сесия към първата.
            ->where('recentResults', fn ($results) => collect($results)->pluck('session_type')->all()
                === ['feature-2', 'feature', 'sprint', 'qualifying', 'practice']));
});

it('връща 404 за несъществуващ F2 пилот', function () {
    $this->get('/f2/drivers/nonexistent')->assertNotFound();
});
