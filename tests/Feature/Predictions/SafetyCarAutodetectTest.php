<?php

declare(strict_types=1);

use App\Models\Driver;
use App\Models\Prediction;
use App\Models\Race;
use App\Models\Result;
use App\Models\Season;
use App\Services\Jolpica\JolpicaException;
use App\Services\Jolpica\ResultSyncService;
use App\Services\LiveTiming\SafetyCarDetector;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

const SAFETY_CAR_TEST_SESSION_KEY = 11377;

/**
 * @return array<int, array<string, mixed>>
 */
function safetyCarRaceSessions(Carbon $raceAt, bool $cancelled = false): array
{
    return [
        // Спринтът от същия уикенд не бива да се бърка с главното състезание.
        [
            'session_key' => 11370, 'session_name' => 'Sprint', 'is_cancelled' => false,
            'date_start' => $raceAt->copy()->subDay()->toIso8601String(),
            'date_end' => $raceAt->copy()->subDay()->addHour()->toIso8601String(),
        ],
        [
            'session_key' => SAFETY_CAR_TEST_SESSION_KEY, 'session_name' => 'Race', 'is_cancelled' => $cancelled,
            'date_start' => $raceAt->toIso8601String(),
            'date_end' => $raceAt->copy()->addHours(2)->toIso8601String(),
        ],
    ];
}

/**
 * Съобщения от дирекцията във формата на OpenF1 (Баку 2026 — два SC периода).
 *
 * @param  array<int, string>  $safetyCarMessages
 * @return array<int, array<string, mixed>>
 */
function safetyCarRaceControl(array $safetyCarMessages, bool $chequered = true): array
{
    $messages = [
        ['date' => '2026-09-26T11:03:00+00:00', 'category' => 'Flag', 'flag' => 'GREEN', 'message' => 'GREEN LIGHT - PIT EXIT OPEN'],
    ];

    foreach ($safetyCarMessages as $index => $text) {
        $messages[] = ['date' => "2026-09-26T11:{$index}0:00+00:00", 'category' => 'SafetyCar', 'flag' => null, 'message' => $text];
    }

    if ($chequered) {
        $messages[] = ['date' => '2026-09-26T12:41:52+00:00', 'category' => 'Flag', 'flag' => 'CHEQUERED', 'message' => 'CHEQUERED FLAG'];
    }

    return $messages;
}

/**
 * @param  array<int, array<string, mixed>>  $messages
 */
function fakeSafetyCarOpenF1(Carbon $raceAt, array $messages, bool $cancelled = false): void
{
    Http::fake([
        'api.openf1.org/v1/sessions*' => Http::response(safetyCarRaceSessions($raceAt, $cancelled)),
        'api.openf1.org/v1/race_control*' => Http::response($messages),
    ]);
}

function safetyCarRaceControlRequested(): bool
{
    return Http::recorded(fn (Request $request): bool => str_contains($request->url(), '/race_control'))->isNotEmpty();
}

beforeEach(function () {
    $this->raceAt = now()->subDay()->startOfHour();
    $this->season = Season::factory()->current()->create(['year' => (int) $this->raceAt->year]);
    $this->race = Race::factory()->create([
        'season_id' => $this->season->id,
        'round' => 15,
        'race_datetime_utc' => $this->raceAt,
        'had_safety_car' => null,
    ]);
});

describe('SafetyCarDetector', function () {
    it('разпознава истински safety car', function () {
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl(['SAFETY CAR DEPLOYED', 'SAFETY CAR IN THIS LAP']));

        $detector = app(SafetyCarDetector::class);

        expect($detector->inspect($this->race))->toBe(['safety_car' => true, 'virtual_safety_car' => false])
            ->and($detector->detect($this->race))->toBeTrue();

        // Сесията е намерена по дата — главното състезание, не спринтът.
        Http::assertSent(fn (Request $request): bool => str_contains($request->url(), '/race_control')
            && $request['session_key'] == SAFETY_CAR_TEST_SESSION_KEY);
    });

    it('не брои виртуалния safety car, освен ако правилото не го разреши', function (string $text) {
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl([$text, 'VSC ENDING']));

        $detector = app(SafetyCarDetector::class);

        expect($detector->inspect($this->race))->toBe(['safety_car' => false, 'virtual_safety_car' => true])
            ->and($detector->detect($this->race))->toBeFalse();

        config(['predictions.safety_car.count_virtual' => true]);

        expect($detector->detect($this->race))->toBeTrue();
    })->with(['VSC DEPLOYED', 'VIRTUAL SAFETY CAR DEPLOYED']);

    it('казва „не" за чисто състезание', function () {
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl([]));

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeFalse();
    });

    it('брои старт и рестарт зад safety car-а, за който OpenF1 не пише DEPLOYED', function (string $text) {
        // Истинските текстове: Спа 2025 (мокър старт) и Интерлагос 2024
        // (рестарт след червен флаг).
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl([$text]));

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeTrue();
    })->with([
        'RACE WILL START BEHIND THE SAFETY CAR',
        'ROLLING START',
        'RACE WILL RESUME AT 14:02 - ROLLING START PROCEDURE',
    ]);

    it('не брои formation lap зад safety car-а, последван от стоящ старт', function () {
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl([
            'FORMATION LAP WILL BE STARTED BEHIND THE SAFETY CAR',
            'STANDING START',
            'INCIDENT INVOLVING CAR 6 (HAD) NOTED - SAFETY CAR INFRINGEMENT',
        ]));

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeFalse();
    });

    it('не взима състезанието от друг уикенд, ако това е отменено', function () {
        Http::fake([
            'api.openf1.org/v1/sessions*' => Http::response([
                [
                    'session_key' => 900, 'session_name' => 'Race', 'is_cancelled' => true,
                    'date_start' => $this->raceAt->toIso8601String(),
                    'date_end' => $this->raceAt->copy()->addHours(2)->toIso8601String(),
                ],
                [
                    'session_key' => 800, 'session_name' => 'Race', 'is_cancelled' => false,
                    'date_start' => $this->raceAt->copy()->subDays(7)->toIso8601String(),
                    'date_end' => $this->raceAt->copy()->subDays(7)->addHours(2)->toIso8601String(),
                ],
            ]),
            'api.openf1.org/v1/race_control*' => Http::response(safetyCarRaceControl(['SAFETY CAR DEPLOYED'])),
        ]);

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeNull()
            ->and(safetyCarRaceControlRequested())->toBeFalse();
    });

    it('не знае без карирания флаг — данните може да са непълни', function () {
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl([], chequered: false));

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeNull();
    });

    it('не знае, ако OpenF1 не отговори', function () {
        Http::fake([
            'api.openf1.org/v1/sessions*' => Http::response(safetyCarRaceSessions($this->raceAt)),
            'api.openf1.org/v1/race_control*' => Http::response([], 500),
        ]);

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeNull();
    });

    it('не пита дирекцията, докато състезанието не е приключило', function () {
        $this->travelTo($this->raceAt->copy()->addHours(2)->addMinutes(10));
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl([]));

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeNull()
            ->and(safetyCarRaceControlRequested())->toBeFalse();
    });

    it('пропуска отменена сесия', function () {
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl(['SAFETY CAR DEPLOYED']), cancelled: true);

        expect(app(SafetyCarDetector::class)->detect($this->race))->toBeNull();
    });

    it('не пита OpenF1 за сезони преди 2023', function () {
        Http::fake();
        $old = Race::factory()->create([
            'season_id' => Season::factory()->create(['year' => 2019])->id,
            'race_datetime_utc' => '2019-09-08 13:10:00',
        ]);

        expect(app(SafetyCarDetector::class)->detect($old))->toBeNull();

        Http::assertNothingSent();
    });
});

describe('при синхрона на резултатите', function () {
    beforeEach(function () {
        config(['predictions.safety_car.autodetect' => true]);

        $this->winner = Driver::factory()->create(['season_id' => $this->season->id]);
        $this->prediction = Prediction::factory()->create([
            'race_id' => $this->race->id,
            'p1_driver_id' => $this->winner->id,
            'safety_car' => true,
        ]);

        $year = $this->season->year;
        $driver = [
            'driverId' => 'russell', 'code' => 'RUS', 'permanentNumber' => '63',
            'givenName' => 'George', 'familyName' => 'Russell', 'nationality' => 'British',
        ];

        Http::fake([
            "*/{$year}/15/results.json*" => Http::response(['MRData' => ['RaceTable' => ['Races' => [[
                'Circuit' => ['circuitId' => $this->race->jolpica_id],
                'Results' => [[
                    'positionText' => '1', 'points' => '25', 'grid' => '1', 'status' => 'Finished',
                    'Driver' => $driver, 'Constructor' => ['constructorId' => 'mercedes', 'name' => 'Mercedes'],
                ]],
            ]]]]]),
            "*/{$year}/15/qualifying.json*" => Http::response(['MRData' => ['RaceTable' => ['Races' => []]]]),
            'api.openf1.org/v1/sessions*' => Http::response(safetyCarRaceSessions($this->raceAt)),
            'api.openf1.org/v1/race_control*' => Http::response(safetyCarRaceControl(['SAFETY CAR DEPLOYED'])),
        ]);
    });

    it('попълва safety car и го точкува в същия синхрон', function () {
        app(ResultSyncService::class)->sync($this->race);

        expect($this->race->fresh()->had_safety_car)->toBeTrue()
            ->and($this->prediction->score()->first()->breakdown_json['safety_car'])
            ->toBe(config('predictions.scoring.safety_car'));
    });

    it('не презаписва ръчно въведения отговор', function () {
        $this->race->update(['had_safety_car' => false]);

        app(ResultSyncService::class)->sync($this->race->fresh());

        expect($this->race->fresh()->had_safety_car)->toBeFalse()
            ->and(safetyCarRaceControlRequested())->toBeFalse();
    });

    it('не пита OpenF1 за кръг без прогнози', function () {
        $this->prediction->delete();

        app(ResultSyncService::class)->sync($this->race);

        expect($this->race->fresh()->had_safety_car)->toBeNull()
            ->and(safetyCarRaceControlRequested())->toBeFalse();
    });

    it('не пита OpenF1, когато автоматиката е изключена', function () {
        config(['predictions.safety_car.autodetect' => false]);

        app(ResultSyncService::class)->sync($this->race);

        expect($this->race->fresh()->had_safety_car)->toBeNull()
            ->and(safetyCarRaceControlRequested())->toBeFalse();
    });
});

describe('разминат календар', function () {
    it('отказва резултати от друго състезание със същия номер на кръга', function () {
        // Сингапур е кръг 16 при нас, а в Jolpica кръг 16 е Малайзия.
        $this->race->update(['jolpica_id' => 'marina_bay', 'round' => 16]);
        $year = $this->season->year;

        Http::fake([
            "*/{$year}/16/results.json*" => Http::response(['MRData' => ['RaceTable' => ['Races' => [[
                'Circuit' => ['circuitId' => 'sepang'],
                'Results' => [[
                    'positionText' => '1', 'points' => '25', 'grid' => '1', 'status' => 'Finished',
                    'Driver' => ['driverId' => 'russell', 'givenName' => 'George', 'familyName' => 'Russell'],
                    'Constructor' => ['constructorId' => 'mercedes', 'name' => 'Mercedes'],
                ]],
            ]]]]]),
            "*/{$year}/16/qualifying.json*" => Http::response(['MRData' => ['RaceTable' => ['Races' => []]]]),
        ]);

        expect(fn () => app(ResultSyncService::class)->sync($this->race->fresh()))
            ->toThrow(JolpicaException::class, 'sepang');

        expect($this->race->results()->count())->toBe(0);
    });
});

it('f1:sync-safety-car предупреждава в лога, когато OpenF1 и след половин ден няма отговор', function () {
    Log::spy();
    Result::factory()->position(1)->create(['race_id' => $this->race->id]);
    Prediction::factory()->create(['race_id' => $this->race->id]);
    fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl(['SAFETY CAR DEPLOYED'], chequered: false));

    $this->artisan('f1:sync-safety-car')->assertSuccessful();

    expect($this->race->fresh()->had_safety_car)->toBeNull();
    Log::shouldHaveReceived('warning')->withArgs(fn (string $message): bool => str_contains($message, 'попълни го ръчно'));
});

describe('f1:sync-safety-car', function () {
    beforeEach(function () {
        Result::factory()->position(1)->create(['race_id' => $this->race->id]);
        $this->prediction = Prediction::factory()->create(['race_id' => $this->race->id, 'safety_car' => true]);
        fakeSafetyCarOpenF1($this->raceAt, safetyCarRaceControl(['SAFETY CAR DEPLOYED']));
    });

    it('само показва при --dry-run', function () {
        $this->artisan('f1:sync-safety-car', ['--dry-run' => true])
            ->expectsOutputToContain('Пробно пускане')
            ->assertSuccessful();

        expect($this->race->fresh()->had_safety_car)->toBeNull()
            ->and($this->prediction->score()->exists())->toBeFalse();
    });

    it('попълва и преточкува', function () {
        $this->artisan('f1:sync-safety-car')->assertSuccessful();

        expect($this->race->fresh()->had_safety_car)->toBeTrue()
            ->and($this->prediction->score()->first()->breakdown_json['safety_car'])
            ->toBe(config('predictions.scoring.safety_car'));
    });

    it('без --force не пипа попълнен кръг, с --force го поправя', function () {
        $this->race->update(['had_safety_car' => false]);

        $this->artisan('f1:sync-safety-car')->expectsOutputToContain('Няма кръгове')->assertSuccessful();
        expect($this->race->fresh()->had_safety_car)->toBeFalse();

        $this->artisan('f1:sync-safety-car', ['--force' => true])->assertSuccessful();
        expect($this->race->fresh()->had_safety_car)->toBeTrue();
    });

    it('и при изрично посочен кръг пази ръчната стойност без --force', function () {
        $this->race->update(['had_safety_car' => false]);

        $this->artisan('f1:sync-safety-car', ['race' => $this->race->id])
            ->expectsOutputToContain('само с --force')
            ->assertSuccessful();

        expect($this->race->fresh()->had_safety_car)->toBeFalse()
            ->and($this->prediction->score()->exists())->toBeFalse();

        $this->artisan('f1:sync-safety-car', ['race' => $this->race->id, '--force' => true])->assertSuccessful();
        expect($this->race->fresh()->had_safety_car)->toBeTrue();
    });
});
