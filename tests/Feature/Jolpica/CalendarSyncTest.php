<?php

declare(strict_types=1);

use App\Models\Prediction;
use App\Models\Race;
use App\Models\Result;
use App\Models\Season;
use App\Services\Jolpica\JolpicaException;
use App\Services\Jolpica\ResultSyncService;
use App\Services\Jolpica\SeasonSyncService;
use App\Services\Telegram\F1ChannelEnqueuer;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Календарът на прода към 26.09.2026 — последно синхронизиран на 18.07, преди
 * Jolpica да вмъкне кръг 16 в Малайзия.
 *
 * @return array<int, array{0:int, 1:string, 2:string}> [кръг, писта, старт UTC]
 */
function productionCalendarBeforeMalaysia(): array
{
    return [
        [1, 'albert_park', '2026-03-08 04:00:00'], [2, 'shanghai', '2026-03-15 07:00:00'],
        [3, 'suzuka', '2026-03-29 05:00:00'], [4, 'miami', '2026-05-03 20:00:00'],
        [5, 'villeneuve', '2026-05-24 20:00:00'], [6, 'monaco', '2026-06-07 13:00:00'],
        [7, 'catalunya', '2026-06-14 13:00:00'], [8, 'red_bull_ring', '2026-06-28 13:00:00'],
        [9, 'silverstone', '2026-07-05 14:00:00'], [10, 'spa', '2026-07-19 13:00:00'],
        [11, 'hungaroring', '2026-07-26 13:00:00'], [12, 'zandvoort', '2026-08-23 13:00:00'],
        [13, 'monza', '2026-09-06 13:00:00'], [14, 'madring', '2026-09-13 13:00:00'],
        [15, 'baku', '2026-09-26 11:00:00'], [16, 'marina_bay', '2026-10-11 12:00:00'],
        [17, 'americas', '2026-10-25 20:00:00'], [18, 'rodriguez', '2026-11-01 20:00:00'],
        [19, 'interlagos', '2026-11-08 17:00:00'], [20, 'vegas', '2026-11-22 04:00:00'],
        [21, 'losail', '2026-11-29 16:00:00'], [22, 'yas_marina', '2026-12-06 13:00:00'],
    ];
}

/**
 * @param  array<int, array{round:int, circuit:string, date:string}>  $races
 */
function fakeJolpicaCalendar(int $year, array $races): void
{
    Http::fake([
        "*/ergast/f1/{$year}.json*" => Http::response(['MRData' => [
            'total' => (string) count($races),
            'RaceTable' => ['Races' => array_map(fn (array $race): array => [
                'season' => (string) $year,
                'round' => (string) $race['round'],
                'raceName' => ucfirst($race['circuit']).' Grand Prix',
                'Circuit' => [
                    'circuitId' => $race['circuit'],
                    'circuitName' => ucfirst($race['circuit']).' Circuit',
                    'Location' => ['country' => 'Somewhere'],
                ],
                'date' => $race['date'],
                'time' => '13:00:00Z',
            ], $races)],
        ]]),
    ]);
}

function calendarRace(Season $season, int $round, string $circuit, string $raceAt): Race
{
    return Race::factory()->create([
        'season_id' => $season->id,
        'round' => $round,
        'jolpica_id' => $circuit,
        'race_datetime_utc' => $raceAt,
    ]);
}

describe('вмъкнат кръг (Малайзия, 26.09.2026)', function () {
    beforeEach(function () {
        $this->season = Season::factory()->create(['year' => 2026, 'is_current' => true]);

        foreach (productionCalendarBeforeMalaysia() as [$round, $circuit, $raceAt]) {
            calendarRace($this->season, $round, $circuit, $raceAt);
        }

        $this->singapore = Race::query()->where('jolpica_id', 'marina_bay')->firstOrFail();
        $this->singaporePrediction = Prediction::factory()->create(['race_id' => $this->singapore->id]);

        Http::fake([
            '*/ergast/f1/2026.json*' => Http::response(
                json_decode(file_get_contents(base_path('tests/Fixtures/jolpica/calendar_2026.json')), true),
            ),
        ]);
    });

    it('добавя новия кръг, без да превръща Сингапур в Малайзия', function () {
        $report = app(SeasonSyncService::class)->syncCalendar($this->season);

        expect(Race::query()->count())->toBe(23)
            ->and($report['created'])->toHaveCount(1)
            ->and($report['renumbered'])->toHaveCount(7)
            ->and($report['removed'])->toBe([]);

        // Същият запис, с прогнозата си — само номерът е друг.
        $singapore = $this->singapore->fresh();
        expect($singapore->jolpica_id)->toBe('marina_bay')
            ->and($singapore->round)->toBe(17)
            ->and($singapore->race_datetime_utc->toDateString())->toBe('2026-10-11')
            ->and($this->singaporePrediction->fresh()->race_id)->toBe($this->singapore->id);

        $malaysia = Race::query()->where('jolpica_id', 'sepang')->firstOrFail();
        expect($malaysia->round)->toBe(16)
            ->and($malaysia->race_datetime_utc->toIso8601String())->toBe('2026-10-04T07:00:00+00:00')
            ->and($malaysia->qualifying_datetime_utc->toIso8601String())->toBe('2026-10-03T08:00:00+00:00')
            ->and($malaysia->name_bg)->toBe('Гран при на Бахрейн в Малайзия')
            ->and($malaysia->sessions()->pluck('type')->map->value->all())->toContain('fp1', 'qualifying', 'race');

        expect(Race::query()->where('jolpica_id', 'yas_marina')->value('round'))->toBe(23)
            ->and(Race::query()->where('jolpica_id', 'baku')->value('round'))->toBe(15);

        // Номерата на кръговете са точно 1..23, без дупки и без „паркирани".
        expect(Race::query()->orderBy('round')->pluck('round')->all())->toBe(range(1, 23));
    });

    it('второто пускане не променя нищо', function () {
        $service = app(SeasonSyncService::class);
        $service->syncCalendar($this->season);

        $report = $service->syncCalendar($this->season);

        expect($report['created'])->toBe([])
            ->and($report['renumbered'])->toBe([])
            ->and($report['removed'])->toBe([])
            ->and(Race::query()->count())->toBe(23);
    });
});

it('не пипа календара, ако Jolpica върне празен списък', function () {
    $season = Season::factory()->create(['year' => 2031]);
    calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');
    fakeJolpicaCalendar(2031, []);

    expect(fn () => app(SeasonSyncService::class)->syncCalendar($season))
        ->toThrow(JolpicaException::class, 'празен календар');

    expect(Race::query()->count())->toBe(1);
});

it('маха изчезнал бъдещ кръг, по който няма нищо', function () {
    $season = Season::factory()->create(['year' => 2031]);
    calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');
    $cancelled = calendarRace($season, 2, 'baku', '2031-09-21 13:00:00');
    calendarRace($season, 3, 'suzuka', '2031-10-05 13:00:00');

    fakeJolpicaCalendar(2031, [
        ['round' => 1, 'circuit' => 'monza', 'date' => '2031-09-07'],
        ['round' => 2, 'circuit' => 'suzuka', 'date' => '2031-10-05'],
    ]);

    $report = app(SeasonSyncService::class)->syncCalendar($season);

    expect($report['removed'])->toHaveCount(1)
        ->and(Race::query()->find($cancelled->id))->toBeNull()
        ->and(Race::query()->where('jolpica_id', 'suzuka')->value('round'))->toBe(2);
});

it('спира, без да пипне нищо, ако изчезналият кръг има прогнози', function () {
    $season = Season::factory()->create(['year' => 2031]);
    calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');
    $cancelled = calendarRace($season, 2, 'baku', '2031-09-21 13:00:00');
    Prediction::factory()->create(['race_id' => $cancelled->id]);

    fakeJolpicaCalendar(2031, [
        ['round' => 1, 'circuit' => 'monza', 'date' => '2031-09-07'],
        ['round' => 2, 'circuit' => 'suzuka', 'date' => '2031-10-05'],
    ]);

    expect(fn () => app(SeasonSyncService::class)->syncCalendar($season))
        ->toThrow(JolpicaException::class, 'кръг 2');

    expect($cancelled->fresh()->round)->toBe(2)
        ->and(Race::query()->where('jolpica_id', 'suzuka')->exists())->toBeFalse();
});

it('спира, ако изчезналият бъдещ кръг вече има резултати от спринта', function () {
    $season = Season::factory()->create(['year' => 2031]);
    calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');
    $sprintWeekend = calendarRace($season, 2, 'baku', '2031-09-21 13:00:00');
    Result::factory()->sprint()->position(1)->create(['race_id' => $sprintWeekend->id]);

    fakeJolpicaCalendar(2031, [
        ['round' => 1, 'circuit' => 'monza', 'date' => '2031-09-07'],
        ['round' => 2, 'circuit' => 'suzuka', 'date' => '2031-10-05'],
    ]);

    expect(fn () => app(SeasonSyncService::class)->syncCalendar($season))
        ->toThrow(JolpicaException::class, 'кръг 2');

    expect($sprintWeekend->fresh())->not->toBeNull()
        ->and(Race::query()->where('jolpica_id', 'suzuka')->exists())->toBeFalse();
});

it('спира, ако изчезналият кръг вече е минал', function () {
    $season = Season::factory()->create(['year' => 2031]);
    $past = calendarRace($season, 1, 'monza', now()->subMonth()->toDateTimeString());

    fakeJolpicaCalendar(2031, [
        ['round' => 1, 'circuit' => 'suzuka', 'date' => now()->addMonth()->toDateString()],
    ]);

    expect(fn () => app(SeasonSyncService::class)->syncCalendar($season))
        ->toThrow(JolpicaException::class);

    expect($past->fresh())->not->toBeNull();
});

it('смята за повреден отговор, който маха повече от два кръга наведнъж', function () {
    $season = Season::factory()->create(['year' => 2031]);

    foreach (['monza', 'baku', 'suzuka', 'losail'] as $index => $circuit) {
        calendarRace($season, $index + 1, $circuit, '2031-09-0'.($index + 1).' 13:00:00');
    }

    fakeJolpicaCalendar(2031, [['round' => 1, 'circuit' => 'monza', 'date' => '2031-09-01']]);

    expect(fn () => app(SeasonSyncService::class)->syncCalendar($season))
        ->toThrow(JolpicaException::class, 'повреден');

    expect(Race::query()->count())->toBe(4);
});

it('различава две състезания на една писта по датата', function () {
    $season = Season::factory()->create(['year' => 2031]);
    // Щирия е създадена първа — иначе редът на id-тата би дал верния отговор
    // и без подреждането по дата.
    $styria = calendarRace($season, 2, 'red_bull_ring', '2031-07-12 13:00:00');
    $austria = calendarRace($season, 1, 'red_bull_ring', '2031-07-05 13:00:00');

    fakeJolpicaCalendar(2031, [
        ['round' => 1, 'circuit' => 'hungaroring', 'date' => '2031-06-28'],
        ['round' => 2, 'circuit' => 'red_bull_ring', 'date' => '2031-07-05'],
        ['round' => 3, 'circuit' => 'red_bull_ring', 'date' => '2031-07-12'],
    ]);

    app(SeasonSyncService::class)->syncCalendar($season);

    expect($austria->fresh()->round)->toBe(2)
        ->and($styria->fresh()->round)->toBe(3);
});

it('не дава съществуващо състезание на вмъкнат по-рано кръг на същата писта', function () {
    $season = Season::factory()->create(['year' => 2031]);
    calendarRace($season, 1, 'americas', '2031-10-25 13:00:00');
    $qatar = calendarRace($season, 2, 'losail', '2031-11-29 13:00:00');
    $prediction = Prediction::factory()->create(['race_id' => $qatar->id]);

    // Нов кръг в Лусаил месец и половина ПРЕДИ съществуващия.
    fakeJolpicaCalendar(2031, [
        ['round' => 1, 'circuit' => 'losail', 'date' => '2031-10-18'],
        ['round' => 2, 'circuit' => 'americas', 'date' => '2031-10-25'],
        ['round' => 3, 'circuit' => 'losail', 'date' => '2031-11-29'],
    ]);

    $report = app(SeasonSyncService::class)->syncCalendar($season);

    expect($qatar->fresh()->round)->toBe(3)
        ->and($qatar->fresh()->race_datetime_utc->toDateString())->toBe('2031-11-29')
        ->and($prediction->fresh()->race_id)->toBe($qatar->id)
        ->and($report['created'])->toHaveCount(1)
        ->and(Race::query()->where('round', 1)->value('race_datetime_utc')->toDateString())->toBe('2031-10-18');
});

it('спира, ако кръг с прогнози би се преместил с повече от седмица', function () {
    $season = Season::factory()->create(['year' => 2031]);
    $race = calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');
    Prediction::factory()->create(['race_id' => $race->id]);

    fakeJolpicaCalendar(2031, [['round' => 1, 'circuit' => 'monza', 'date' => '2031-10-19']]);

    expect(fn () => app(SeasonSyncService::class)->syncCalendar($season))
        ->toThrow(JolpicaException::class, 'повече от седмица');

    expect($race->fresh()->race_datetime_utc->toDateString())->toBe('2031-09-07');
});

it('мести без въпроси кръг без прогнози и отчита новия час', function () {
    $season = Season::factory()->create(['year' => 2031]);
    $race = calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');

    fakeJolpicaCalendar(2031, [['round' => 1, 'circuit' => 'monza', 'date' => '2031-10-19']]);

    $report = app(SeasonSyncService::class)->syncCalendar($season);

    expect($race->fresh()->race_datetime_utc->toDateString())->toBe('2031-10-19')
        ->and($report['rescheduled'])->toHaveCount(1)
        ->and($report['rescheduled'][0])->toContain('старт 07.09 13:00 → 19.10 13:00 UTC');
});

it('пази ръчно поправените часове', function () {
    $season = Season::factory()->create(['year' => 2031]);
    $race = calendarRace($season, 1, 'monza', '2031-09-07 14:00:00');
    $race->update([
        'qualifying_datetime_utc' => '2031-09-06 13:00:00',
        'manual_schedule' => true,
        'name' => 'Старо име',
    ]);

    fakeJolpicaCalendar(2031, [['round' => 1, 'circuit' => 'monza', 'date' => '2031-09-07']]);

    $report = app(SeasonSyncService::class)->syncCalendar($season);

    $race->refresh();
    expect($race->race_datetime_utc->format('H:i'))->toBe('14:00')
        ->and($race->qualifying_datetime_utc->toDateTimeString())->toBe('2031-09-06 13:00:00')
        ->and($race->name)->toBe('Monza Grand Prix')
        ->and($report['kept_manual'])->toHaveCount(1)
        ->and($report['rescheduled'])->toBe([]);
});

it('разпознава състезанието по дата, ако пистата е сменила идентификатора си', function () {
    $season = Season::factory()->create(['year' => 2031]);
    $race = calendarRace($season, 1, 'old_circuit_id', '2031-09-07 13:00:00');
    Prediction::factory()->create(['race_id' => $race->id]);

    fakeJolpicaCalendar(2031, [['round' => 1, 'circuit' => 'new_circuit_id', 'date' => '2031-09-07']]);

    app(SeasonSyncService::class)->syncCalendar($season);

    expect(Race::query()->count())->toBe(1)
        ->and($race->fresh()->jolpica_id)->toBe('new_circuit_id');
});

it('командата синхронизира текущия сезон', function () {
    $season = Season::factory()->create(['year' => 2031, 'is_current' => true]);
    calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');

    fakeJolpicaCalendar(2031, [
        ['round' => 1, 'circuit' => 'sepang', 'date' => '2031-08-30'],
        ['round' => 2, 'circuit' => 'monza', 'date' => '2031-09-07'],
    ]);

    $this->artisan('f1:sync-calendar')
        ->expectsOutputToContain('нов: кръг 1')
        ->expectsOutputToContain('преномериран:')
        ->assertSuccessful();

    expect(Race::query()->where('jolpica_id', 'monza')->value('round'))->toBe(2);
});

it('напомня за новия сезон, когато текущият е свършил и Jolpica вече го има', function () {
    Log::spy();

    $season = Season::factory()->create(['year' => 2031, 'is_current' => true]);
    calendarRace($season, 1, 'monza', now()->subDays(10)->toDateTimeString());

    Http::fake([
        '*/ergast/f1/2031.json*' => Http::response(['MRData' => ['total' => '1', 'RaceTable' => ['Races' => [[
            'round' => '1', 'raceName' => 'Italian Grand Prix',
            'Circuit' => ['circuitId' => 'monza', 'circuitName' => 'Monza', 'Location' => ['country' => 'Italy']],
            'date' => now()->subDays(10)->toDateString(), 'time' => now()->subDays(10)->format('H:i:s').'Z',
        ]]]]]),
        '*/ergast/f1/2032.json*' => Http::response(['MRData' => ['total' => '1', 'RaceTable' => ['Races' => [[
            'round' => '1', 'raceName' => 'Australian Grand Prix',
            'Circuit' => ['circuitId' => 'albert_park'], 'date' => '2032-03-07', 'time' => '04:00:00Z',
        ]]]]]),
    ]);

    $this->artisan('f1:sync-calendar')
        ->expectsOutputToContain('f1:sync-season 2032')
        ->assertSuccessful();

    Log::shouldHaveReceived('warning')->withArgs(fn (string $message): bool => str_contains($message, 'Сезон 2032'));
});

it('не пита за новия сезон, докато текущият тече', function () {
    $season = Season::factory()->create(['year' => 2031, 'is_current' => true]);
    calendarRace($season, 1, 'monza', now()->addDays(3)->toDateTimeString());
    fakeJolpicaCalendar(2031, [['round' => 1, 'circuit' => 'monza', 'date' => now()->addDays(3)->toDateString()]]);

    $this->artisan('f1:sync-calendar')->assertSuccessful();

    Http::assertNotSent(fn ($request): bool => str_contains($request->url(), '/2032'));
});

it('f1:sync-results пише в лога, когато откаже резултати от разминат календар', function () {
    Log::spy();
    $this->mock(F1ChannelEnqueuer::class)
        ->shouldReceive('enqueuePending')
        ->andReturn(['queued' => 0, 'updated' => 0, 'errors' => []]);
    $this->mock(ResultSyncService::class)
        ->shouldReceive('sync')
        ->andThrow(new JolpicaException('Кръг 16 в Jolpica е на „sepang", а при нас е на „marina_bay"'));

    $season = Season::factory()->create(['year' => 2031, 'is_current' => true]);
    calendarRace($season, 16, 'marina_bay', now()->subHour()->toDateTimeString());

    $this->artisan('f1:sync-results')->assertFailed();

    Log::shouldHaveReceived('error')->withArgs(fn (string $message): bool => str_contains($message, 'sepang'));
});

it('командата пише в лога и връща грешка, когато синхронът спре', function () {
    Log::spy();

    $season = Season::factory()->create(['year' => 2031, 'is_current' => true]);
    calendarRace($season, 1, 'monza', '2031-09-07 13:00:00');
    fakeJolpicaCalendar(2031, []);

    $this->artisan('f1:sync-calendar')->assertFailed();

    Log::shouldHaveReceived('error')->withArgs(fn (string $message): bool => str_contains($message, 'празен календар'));
});
