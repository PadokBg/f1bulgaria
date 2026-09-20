<?php

declare(strict_types=1);

use App\Models\F2Driver;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use App\Services\F2\Api\F2ApiSync;
use Illuminate\Http\Client\ResponseSequence;
use Illuminate\Support\Facades\Http;

/*
 * Един пилот — един ред.
 *
 * Регресията: Wikipedia синхронът записа „Alex Dunne", официалното API после
 * върна „Alexander Dunne". Slug-овете се разминават, старият ред няма
 * driver_reference, и съпоставянето създаде втори ред. На прод (20.09.2026)
 * това даде по два реда за Дън в 2025 и 2026 и по два за Фитипалди, а /tsolov
 * показваше един и същ пилот два пъти в топ 5.
 */

/**
 * Редовете за състезанието. Подай ResponseSequence, когато тестът
 * синхронизира два пъти с различен payload.
 *
 * @param  array<int, array<string, mixed>>|ResponseSequence  $results
 * @param  array<int, array<string, mixed>>  $standings
 */
function fakeDupApi(array|ResponseSequence $results, array $standings = []): void
{
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(
            '<script>self.__next_f.push([1,"{\\"key\\":{\\"public\\":\\"TESTKEY1234567890ABC\\"}}"])</script>'
        ),

        'api.formula1.com/*/meetings*' => Http::response(['meetings' => [[
            'meetingKey' => '1291',
            'meetingName' => 'Hungarian Grand Prix',
            'meetingLocation' => 'Budapest',
            'meetingCountryName' => 'Hungary',
            'roundText' => 'ROUND 9',
            'gmtOffset' => '+02:00',
            'isTestEvent' => false,
            'meetingSessions' => [[
                'session' => 'r',
                'startTime' => '2026-07-26T12:30:00',
                'endTime' => '2026-07-26T13:30:00',
                'gmtOffset' => '+02:00',
                'state' => 'completed',
            ]],
        ]]]),

        'api.formula1.com/*/race*' => $results instanceof ResponseSequence
            ? $results
            : Http::response(['sessionResults' => ['results' => $results]]),

        'api.formula1.com/*/driver-standings-breakdown*' => Http::response(['standings' => $standings]),
    ]);
}

/**
 * @return array<string, mixed>
 */
function dupRow(string $first, string $last, ?string $reference, int $position = 1, string $version = 'Final'): array
{
    return array_filter([
        'positionNumber' => (string) $position,
        'driverFirstName' => $first,
        'driverLastName' => $last,
        'driverReference' => $reference,
        'driverTLA' => 'DUN',
        'racingNumber' => '15',
        'teamName' => 'Rodin Motorsport',
        'teamKey' => '9',
        'displayTime' => '55:04.742',
        'racePoints' => 25,
        'lapsCompleted' => 37,
        'completionStatusCode' => 'OK',
        'version' => $version,
    ], fn ($value): bool => $value !== null);
}

// ── Синхронът ───────────────────────────────────────────────────────────────

it('преименуван пилот обновява реда си вместо да създаде втори', function () {
    // Двата отговора идват от ЕДИН fake като последователност. Повторно
    // извикване на Http::fake само трупа stub-ове и печели първият съвпаднал,
    // тоест вторият синхрон пак би получил стария payload.
    //
    // Първият отговор е временен нарочно: финализирана сесия не се
    // пресинхронизира (виж needsResults).
    fakeDupApi(Http::sequence()
        ->push(['sessionResults' => ['results' => [dupRow('Alex', 'Dunne', 'ALEDUN01', 1, 'Provisional')]]])
        ->push(['sessionResults' => ['results' => [dupRow('Alexander', 'Dunne', 'ALEDUN01')]]]));

    app(F2ApiSync::class)->syncSeason(2026);

    expect(F2Driver::query()->count())->toBe(1);

    // Вторият синхрон носи новото изписване при същия reference.
    app(F2ApiSync::class)->syncSeason(2026);

    $drivers = F2Driver::query()->get();

    expect($drivers)->toHaveCount(1)
        ->and($drivers->first()->first_name)->toBe('Alexander')
        ->and($drivers->first()->slug)->toBe('alexander-dunne')
        ->and($drivers->first()->driver_reference)->toBe('ALEDUN01');
});

it('осиновява стария ред без reference вместо да го дублира', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    // Такъв ред оставя Wikipedia синхронът: име, но без ключ от API-то.
    $legacy = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alex',
        'last_name' => 'Dunne',
        'slug' => 'alex-dunne',
        'country_code' => 'IRL',
    ]);

    fakeDupApi([dupRow('Alex', 'Dunne', 'ALEDUN01')]);
    app(F2ApiSync::class)->syncSeason(2026);

    expect(F2Driver::query()->count())->toBe(1)
        ->and($legacy->fresh()->driver_reference)->toBe('ALEDUN01')
        // Държавата от по-надеждния източник не се губи.
        ->and($legacy->fresh()->country_code)->toBe('IRL');
});

it('не присвоява ред с ЧУЖД reference само защото slug-ът съвпада', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    $other = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alex',
        'last_name' => 'Dunne',
        'slug' => 'alex-dunne',
        'driver_reference' => 'OTHDUN99',
    ]);

    fakeDupApi([dupRow('Alex', 'Dunne', 'ALEDUN01')]);
    app(F2ApiSync::class)->syncSeason(2026);

    // Чуждият ред остава непокътнат; новият пилот получава свой.
    expect($other->fresh()->driver_reference)->toBe('OTHDUN99')
        ->and(F2Driver::query()->where('driver_reference', 'ALEDUN01')->exists())->toBeTrue();
});

it('пази стария slug, когато новото име е заето от друг ред', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alex',
        'last_name' => 'Dunne',
        'slug' => 'alex-dunne',
        'driver_reference' => 'OTHDUN99',
    ]);

    $renamed = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alexander',
        'last_name' => 'Dunne',
        'slug' => 'alexander-dunne',
        'driver_reference' => 'ALEDUN01',
    ]);

    // API-то преименува ALEDUN01 на „Alex Dunne" — slug-ът е зает.
    fakeDupApi([dupRow('Alex', 'Dunne', 'ALEDUN01')]);
    app(F2ApiSync::class)->syncSeason(2026);

    // Без гръмнал unique индекс и без спрян синхрон.
    expect($renamed->fresh()->slug)->toBe('alexander-dunne')
        ->and($renamed->fresh()->first_name)->toBe('Alex')
        ->and(F2Driver::query()->count())->toBe(2);
});

it('пропуска безименен ред вместо да създаде пилот с празен slug', function () {
    fakeDupApi([
        dupRow('Noel', 'Leon', 'NOELEO01'),
        // Ред без име и без reference — на прод такъв събра три резултата.
        ['positionNumber' => '2', 'racingNumber' => '20', 'racePoints' => 18, 'version' => 'Final'],
    ]);

    $stats = app(F2ApiSync::class)->syncSeason(2026);

    expect(F2Driver::query()->count())->toBe(1)
        ->and(F2Driver::query()->where('slug', '')->exists())->toBeFalse()
        ->and($stats['skipped_drivers'])->toBe(1)
        // Резултатът на безименния също не влиза.
        ->and(F2Result::query()->count())->toBe(1);
});

// ── Командата за сливане ────────────────────────────────────────────────────

/**
 * @return array{0: F2Season, 1: F2Driver, 2: F2Driver}
 */
function dunnePair(): array
{
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    $legacy = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alex',
        'last_name' => 'Dunne',
        'slug' => 'alex-dunne',
        'country_code' => 'IRL',
        'position' => 4,
        'points' => 108,
    ]);

    $official = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alexander',
        'last_name' => 'Dunne',
        'slug' => 'alexander-dunne',
        'driver_reference' => 'ALEDUN01',
        'tla' => 'DUN',
        'position' => 4,
        'points' => 139,
    ]);

    return [$season, $legacy, $official];
}

it('само отчита, без --apply', function () {
    [, $legacy, $official] = dunnePair();

    $this->artisan('f2:merge-duplicate-drivers')
        ->expectsOutputToContain('Сезон 2026')
        ->expectsOutputToContain("остава #{$official->id}")
        ->expectsOutputToContain('Нищо НЕ е променено')
        ->assertSuccessful();

    expect(F2Driver::query()->count())->toBe(2)
        ->and($legacy->fresh())->not->toBeNull()
        ->and($official->fresh())->not->toBeNull();
});

it('показва безименните редове, но не ги пипа', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    $ghost = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => '',
        'last_name' => '',
        'slug' => '',
    ]);

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])
        ->expectsOutputToContain('Безименни редове')
        ->expectsOutputToContain("#{$ghost->id}")
        ->assertSuccessful();

    expect($ghost->fresh())->not->toBeNull();
});

it('слива двата реда и оставя този с reference', function () {
    [, $legacy, $official] = dunnePair();

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])->assertSuccessful();

    expect(F2Driver::query()->count())->toBe(1)
        ->and($legacy->fresh())->toBeNull()
        ->and($official->fresh()->driver_reference)->toBe('ALEDUN01')
        // Държавата идва от изтрития ред — официалният я нямаше.
        ->and($official->fresh()->country_code)->toBe('IRL');
});

it('пренася резултатите, пол позицията и най-бързата обиколка', function () {
    [$season, $legacy, $official] = dunnePair();

    $race = $season->races()->create([
        'location_name' => 'Budapest',
        'round' => 9,
        'slug' => '2026-budapest',
    ]);

    $sessionA = F2RaceSession::create([
        'f2_race_id' => $race->id,
        'session_type' => 'feature_race',
        'date' => '2026-07-26',
        'pole_position_driver_id' => $legacy->id,
        'fastest_lap_driver_id' => $legacy->id,
    ]);

    F2Result::create([
        'f2_race_session_id' => $sessionA->id,
        'f2_driver_id' => $legacy->id,
        'position' => 3,
        'points' => 15,
    ]);

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])->assertSuccessful();

    expect(F2Result::query()->where('f2_driver_id', $official->id)->count())->toBe(1)
        ->and($sessionA->fresh()->pole_position_driver_id)->toBe($official->id)
        ->and($sessionA->fresh()->fastest_lap_driver_id)->toBe($official->id);
});

it('не оставя два резултата за една сесия', function () {
    [$season, $legacy, $official] = dunnePair();

    $race = $season->races()->create([
        'location_name' => 'Budapest',
        'round' => 9,
        'slug' => '2026-budapest',
    ]);

    $session = F2RaceSession::create([
        'f2_race_id' => $race->id,
        'session_type' => 'feature_race',
        'date' => '2026-07-26',
    ]);

    // И двата реда имат резултат за СЪЩАТА сесия — (сесия, пилот) е уникален.
    F2Result::create(['f2_race_session_id' => $session->id, 'f2_driver_id' => $legacy->id, 'position' => 9, 'points' => 2]);
    F2Result::create(['f2_race_session_id' => $session->id, 'f2_driver_id' => $official->id, 'position' => 3, 'points' => 15]);

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])->assertSuccessful();

    $results = F2Result::query()->get();

    expect($results)->toHaveCount(1)
        ->and($results->first()->f2_driver_id)->toBe($official->id)
        // Остава резултатът на канонния ред, не на изтривания.
        ->and($results->first()->position)->toBe(3);
});

it('без нито един reference оставя реда с повече резултати', function () {
    // Случаят от сезон 2025 на прод: и двата реда идват от Wikipedia, тоест
    // никой няма ключ от API-то. Тогава решават закачените резултати, не
    // точките — точките се презаписват от следващия синхрон на класирането.
    $season = F2Season::create(['year' => 2025, 'is_current' => false]);

    $race = $season->races()->create(['location_name' => 'Monza', 'round' => 10, 'slug' => '2025-monza']);
    $session = F2RaceSession::create([
        'f2_race_id' => $race->id,
        'session_type' => 'feature_race',
        'date' => '2025-09-01',
    ]);

    $thin = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alexander', 'last_name' => 'Dunne', 'slug' => 'alexander-dunne',
        'position' => 23, 'points' => 0,
    ]);
    $rich = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alex', 'last_name' => 'Dunne', 'slug' => 'alex-dunne',
        'position' => 5, 'points' => 99,
    ]);

    F2Result::create(['f2_race_session_id' => $session->id, 'f2_driver_id' => $rich->id, 'position' => 5, 'points' => 10]);

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])->assertSuccessful();

    expect(F2Driver::query()->count())->toBe(1)
        ->and(F2Driver::query()->first()->id)->toBe($rich->id)
        ->and($thin->fresh())->toBeNull();
});

it('не пипа двама пилоти с различни reference', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Alex', 'last_name' => 'Dunne', 'slug' => 'alex-dunne',
        'driver_reference' => 'ALEDUN01',
    ]);
    F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Aaron', 'last_name' => 'Dunne', 'slug' => 'aaron-dunne',
        'driver_reference' => 'AARDUN01',
    ]);

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])->assertSuccessful();

    expect(F2Driver::query()->count())->toBe(2);
});

it('разпознава и разминаване в наставката на фамилията', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Emerson', 'last_name' => 'Fittipaldi Jr.', 'slug' => 'emerson-fittipaldi-jr',
        'points' => 10,
    ]);
    $official = F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Emerson', 'last_name' => 'Fittipaldi', 'slug' => 'emerson-fittipaldi',
        'driver_reference' => 'EMEFIT02', 'points' => 28,
    ]);

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])->assertSuccessful();

    expect(F2Driver::query()->count())->toBe(1)
        ->and(F2Driver::query()->first()->id)->toBe($official->id);
});

it('не слива пилоти от различни сезони', function () {
    $a = F2Season::create(['year' => 2025, 'is_current' => false]);
    $b = F2Season::create(['year' => 2026, 'is_current' => true]);

    foreach ([$a, $b] as $season) {
        F2Driver::create([
            'f2_season_id' => $season->id,
            'first_name' => 'Alex', 'last_name' => 'Dunne', 'slug' => 'alex-dunne',
        ]);
    }

    $this->artisan('f2:merge-duplicate-drivers', ['--apply' => true])->assertSuccessful();

    expect(F2Driver::query()->count())->toBe(2);
});
