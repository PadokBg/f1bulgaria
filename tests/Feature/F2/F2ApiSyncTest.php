<?php

declare(strict_types=1);

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2Race;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use App\Services\F2\Api\F2ApiClient;
use App\Services\F2\Api\F2ApiException;
use App\Services\F2\Api\F2ApiSync;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Полезният товар в страницата на fiaformula2.com е backslash-escape-нат.
 * Наивният шаблон `"public":"…"` не хваща нищо — точно затова тестът пази
 * реалната форма.
 */
function f2KeyPage(): string
{
    return '<script>self.__next_f.push([1,"{\\"key\\":{\\"public\\":\\"TESTKEY1234567890ABC\\"}}"])</script>';
}

/**
 * @param  array<int, array<string, mixed>>  $sessions
 * @return array<string, mixed>
 */
function f2Meeting(array $sessions): array
{
    return [
        'meetings' => [[
            'meetingKey' => '1291',
            'meetingName' => 'Hungarian Grand Prix',
            'meetingLocation' => 'Budapest',
            'meetingCountryName' => 'Hungary',
            'roundText' => 'ROUND 9',
            'gmtOffset' => '+02:00',
            'isTestEvent' => false,
            'meetingSessions' => $sessions,
        ]],
    ];
}

/**
 * @return array<string, mixed>
 */
function f2Session(string $code, string $state = 'completed'): array
{
    return [
        'session' => $code,
        'startTime' => '2026-07-26T12:30:00',
        'endTime' => '2026-07-26T13:30:00',
        'gmtOffset' => '+02:00',
        'state' => $state,
    ];
}

/**
 * Сесия във формата на API-то от 28.07.2026: вид и номер вместо кратък код.
 * Полето `session` („Race 2") е само за четене от хора.
 *
 * @param  array<string, mixed>  $overrides
 * @return array<string, mixed>
 */
function f2SessionV2(string $type, int $number, array $overrides = []): array
{
    return [
        'session' => "{$type} {$number}",
        'sessionType' => $type,
        'sessionNumber' => $number,
        'startTime' => '2026-09-26T11:00:00',
        'endTime' => '2026-09-26T12:05:00',
        'gmtOffset' => '+04:00',
        'state' => 'completed',
        ...$overrides,
    ];
}

/**
 * Пуска се изрично, а не в beforeEach: Http::fake трупа stub-ове и печели
 * първият съвпаднал, тоест регистриран в beforeEach шаблон би засенчил
 * всеки по-специфичен, зададен после в самия тест.
 */
function fakeF2Api(): void
{
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),

        'api.formula1.com/*/meetings*' => Http::response(f2Meeting([
            f2Session('p'),
            f2Session('q'),
            f2Session('r'),
        ])),

        'api.formula1.com/*/practice*' => Http::response(['sessionResults' => ['results' => [
            [
                'positionNumber' => '1', 'driverFirstName' => 'Noel', 'driverLastName' => 'Leon',
                'driverReference' => 'NOELEO01', 'driverTLA' => 'LEO', 'racingNumber' => '5',
                'teamName' => 'Campos Racing', 'teamKey' => '12', 'teamColourCode' => 'FF0000',
                'classifiedTime' => '1:30.720', 'gapToLeader' => 0, 'lapsCompleted' => 14,
            ],
        ]]]),

        'api.formula1.com/*/qualifying*' => Http::response(['sessionResults' => ['results' => [
            [
                'positionNumber' => '1', 'driverFirstName' => 'Kush', 'driverLastName' => 'Maini',
                'driverReference' => 'KUSMAI01', 'driverTLA' => 'MAI', 'racingNumber' => '7',
                'teamName' => 'ART Grand Prix', 'classifiedTime' => '1:28.896', 'lapsCompleted' => 9,
                'completionStatusCode' => 'OK',
            ],
        ]]]),

        'api.formula1.com/*/race*' => Http::response(['sessionResults' => ['results' => [
            [
                'positionNumber' => '1', 'driverFirstName' => 'Noel', 'driverLastName' => 'Leon',
                'driverReference' => 'NOELEO01', 'driverTLA' => 'LEO', 'teamName' => 'Campos Racing',
                'displayTime' => '55:04.742', 'gapToLeader' => 0, 'racePoints' => 25,
                'lapsCompleted' => 37, 'completionStatusCode' => 'OK', 'version' => 'Final',
            ],
            [
                'positionNumber' => '666', 'displayPosition' => 'NC',
                'driverFirstName' => 'Nikola', 'driverLastName' => 'Tsolov',
                'driverReference' => 'NIKTSO01', 'driverTLA' => 'TSO', 'teamName' => 'Campos Racing',
                'racePoints' => 0, 'lapsCompleted' => 12,
                'completionStatusCode' => 'DNF', 'version' => 'Final',
            ],
        ]]]),

        'api.formula1.com/*/driver-standings-breakdown*' => Http::response(['standings' => [
            ['driverReference' => 'NIKTSO01', 'driverFirstName' => 'Nikola', 'driverLastName' => 'Tsolov', 'championshipPoints' => 167],
            ['driverReference' => 'NOELEO01', 'driverFirstName' => 'Noel', 'driverLastName' => 'Leon', 'championshipPoints' => 94],
        ]]),
    ]);
}

it('вади ключа от escape-натия payload на страницата', function () {
    fakeF2Api();
    app(F2ApiClient::class)->meetings(2026);

    Http::assertSent(fn ($request) => $request->hasHeader('apikey', 'TESTKEY1234567890ABC'));
});

it('се проваля разбираемо, когато ключът липсва в страницата', function () {
    Http::fake(['www.fiaformula2.com/*' => Http::response('<html>нищо</html>')]);

    expect(fn () => app(F2ApiClient::class)->meetings(2026))
        ->toThrow(F2ApiException::class);
});

it('създава кръг, сесии и резултати от календара', function () {
    fakeF2Api();
    $stats = app(F2ApiSync::class)->syncSeason(2026);

    expect($stats['rounds'])->toBe(1)
        ->and($stats['sessions'])->toBe(3);

    $race = F2Race::query()->first();

    expect($race->round)->toBe(9)
        ->and($race->meeting_key)->toBe('1291')
        ->and($race->country_name)->toBe('Hungary')
        ->and($race->location_name)->toBe('Budapest');

    expect(F2RaceSession::query()->pluck('session_type')->map(fn ($t) => $t->value)->sort()->values()->all())
        ->toBe(['feature_race', 'practice', 'qualifying']);
});

it('превръща местното време на сесията в UTC', function () {
    fakeF2Api();
    app(F2ApiSync::class)->syncSeason(2026);

    // 12:30 при отместване +02:00 е 10:30 UTC.
    expect(F2RaceSession::query()->first()->scheduled_at_utc->toDateTimeString())
        ->toBe('2026-07-26 10:30:00');
});

it('пази абсолютната обиколка за тренировка и квалификация', function () {
    fakeF2Api();
    app(F2ApiSync::class)->syncSeason(2026);

    $practice = F2RaceSession::query()->where('session_type', F2SessionType::Practice->value)->first();

    expect($practice->results()->first()->time_or_gap)->toBe('1:30.720');
});

it('превръща сентинела 666 в липсваща позиция, а не го записва', function () {
    fakeF2Api();
    app(F2ApiSync::class)->syncSeason(2026);

    $tsolov = F2Driver::query()->where('driver_reference', 'NIKTSO01')->first();
    $result = F2Result::query()->where('f2_driver_id', $tsolov->id)->first();

    expect($result->position)->toBeNull()
        ->and($result->status)->toBe('DNF');
});

it('взима класирането наготово от API-то, без да го смята', function () {
    fakeF2Api();
    app(F2ApiSync::class)->syncSeason(2026);

    $tsolov = F2Driver::query()->where('driver_reference', 'NIKTSO01')->first();

    // 167 точки включват бонусите за пол позиция, които racePoints изключва —
    // затова класирането идва от отделния endpoint.
    expect((float) $tsolov->points)->toBe(167.0)
        ->and($tsolov->position)->toBe(1);
});

it('записва pole върху квалификацията и го пренася върху главното състезание', function () {
    fakeF2Api();
    app(F2ApiSync::class)->syncSeason(2026);

    $feature = F2RaceSession::query()->where('session_type', F2SessionType::FeatureRace->value)->first();
    $maini = F2Driver::query()->where('driver_reference', 'KUSMAI01')->first();

    expect($feature->pole_position_driver_id)->toBe($maini->id)
        ->and($feature->pole_position_time)->toBe('1:28.896');
});

it('не дърпа наново класация на вече свалена тренировка', function () {
    fakeF2Api();
    app(F2ApiSync::class)->syncSeason(2026);
    $first = count(Http::recorded());

    app(F2ApiSync::class)->syncSeason(2026);
    $second = count(Http::recorded()) - $first;

    // При второто пускане трябват само календарът и класирането — резултатите
    // на приключилите сесии вече са в базата.
    expect($second)->toBeLessThan($first);
});

it('не създава дубликати при повторен синхрон', function () {
    fakeF2Api();
    app(F2ApiSync::class)->syncSeason(2026);
    app(F2ApiSync::class)->syncSeason(2026);

    expect(F2Race::query()->count())->toBe(1)
        ->and(F2RaceSession::query()->count())->toBe(3)
        ->and(F2Result::query()->count())->toBe(4);
});

it('не се дави, когато API-то няма данни за сезона', function () {
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*' => Http::response(['meetings' => []]),
    ]);

    $stats = app(F2ApiSync::class)->syncSeason(2019);

    expect($stats['rounds'])->toBe(0)
        ->and($stats['errors'])->not->toBeEmpty()
        ->and(F2Race::query()->count())->toBe(0);
});

it('презарежда ключа при 401 и повтаря веднъж', function () {
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*' => Http::sequence()
            ->push(['detail' => 'unauthorized'], 401)
            ->push(['meetings' => []], 200),
    ]);

    expect(app(F2ApiClient::class)->meetings(2026))->toBe([]);
    // Ключът, календарът с 401, ключът наново и повторният календар.
    expect(count(Http::recorded()))->toBe(4);
});

it('пропуска тестовите събития, за да не разместят номерата на кръговете', function () {
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*/meetings*' => Http::response(['meetings' => [[
            'meetingKey' => '1200',
            'meetingName' => 'Pre-Season Testing',
            'roundText' => 'ROUND 1',
            'isTestEvent' => true,
            'meetingSessions' => [f2Session('p')],
        ]]]),
        'api.formula1.com/*' => Http::response(['standings' => []]),
    ]);

    app(F2ApiSync::class)->syncSeason(2026);

    expect(F2Race::query()->count())->toBe(0);
});

it('разпознава вида на сесията по sessionType и sessionNumber', function (array $session, ?F2SessionType $expected) {
    expect(F2SessionType::fromApiSession($session))->toBe($expected);
})->with([
    'тренировка' => [['sessionType' => 'Practice', 'sessionNumber' => 0], F2SessionType::Practice],
    'квалификация' => [['sessionType' => 'Qualifying', 'sessionNumber' => 0], F2SessionType::Qualifying],
    'група А' => [['sessionType' => 'Qualifying', 'sessionNumber' => 1], F2SessionType::QualifyingGroupA],
    'група Б' => [['sessionType' => 'Qualifying', 'sessionNumber' => 2], F2SessionType::QualifyingGroupB],
    'спринт' => [['sessionType' => 'Race', 'sessionNumber' => 1], F2SessionType::SprintRace],
    'главно' => [['sessionType' => 'Race', 'sessionNumber' => 2], F2SessionType::FeatureRace],
    'второ главно (Баку 2026)' => [['sessionType' => 'Race', 'sessionNumber' => 3], F2SessionType::SecondFeatureRace],
    'стар код r1' => [['session' => 'r1'], F2SessionType::SprintRace],
    'стар код r' => [['session' => 'r'], F2SessionType::FeatureRace],
    // Иначе втора тренировка би презаписала първата в същия ред.
    'тренировка с друг номер' => [['sessionType' => 'Practice', 'sessionNumber' => 1], null],
    'непознат вид' => [['sessionType' => 'Shootout', 'sessionNumber' => 1], null],
]);

it('синхронизира кръг във формата от 28.07.2026, с второто главно състезание', function () {
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        // Баку 2026: квалификация в две групи и три състезания.
        'api.formula1.com/*/meetings*' => Http::response(f2Meeting([
            f2SessionV2('Practice', 0),
            f2SessionV2('Qualifying', 1),
            f2SessionV2('Qualifying', 2),
            f2SessionV2('Race', 1),
            f2SessionV2('Race', 2),
            f2SessionV2('Race', 3),
        ])),
        // Втората квалификация нарежда второто главно — там pole е друг.
        'api.formula1.com/*/qualifying*session=2*' => Http::response(['sessionResults' => ['results' => [[
            'positionNumber' => '1', 'driverFirstName' => 'Martinius', 'driverLastName' => 'Stenshorne',
            'driverReference' => 'MARSTE01', 'teamName' => 'Rodin Motorsport', 'classifiedTime' => '1:53.728',
        ]]]]),
        'api.formula1.com/*' => Http::response(['sessionResults' => ['results' => [[
            'positionNumber' => '1', 'driverFirstName' => 'Rafael', 'driverLastName' => 'Câmara',
            'driverReference' => 'RAFCAM01', 'teamName' => 'Invicta Racing', 'racePoints' => 25,
            'classifiedTime' => '1:55.383', 'completionStatusCode' => 'OK', 'version' => 'Final',
        ]]]]),
    ]);

    $stats = app(F2ApiSync::class)->syncSeason(2026);

    expect($stats['sessions'])->toBe(6)
        ->and($stats['results'])->toBe(6)
        ->and($stats['errors'])->toBe([]);

    expect(F2RaceSession::query()->pluck('session_type')->map(fn ($t) => $t->value)->sort()->values()->all())
        ->toBe(['feature_race', 'feature_race_2', 'practice', 'qualifying_group_a', 'qualifying_group_b', 'sprint_race']);

    // Второто главно е `race` със session=3; с друг номер резултатите му биха
    // дошли от първото.
    Http::assertSent(fn ($request) => str_contains($request->url(), '/race?') && str_contains($request->url(), 'session=3'));

    $pole = fn (F2SessionType $type): ?string => F2RaceSession::query()
        ->where('session_type', $type->value)->first()->poleDriver?->last_name;

    expect($pole(F2SessionType::FeatureRace))->toBe('Câmara')
        ->and($pole(F2SessionType::SecondFeatureRace))->toBe('Stenshorne')
        ->and(F2RaceSession::query()->where('session_type', F2SessionType::SecondFeatureRace->value)->value('pole_position_time'))
        ->toBe('1:53.728');
});

it('маха сесия, която календарът вече не изрежда, само ако е без резултати', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $race = F2Race::create([
        'f2_season_id' => $season->id, 'round' => 9, 'location_name' => 'Budapest', 'slug' => '2026-budapest',
        'race_datetime_utc' => '2026-07-26 09:25:00',
    ]);
    $driver = F2Driver::create(['f2_season_id' => $season->id, 'first_name' => 'Noel', 'last_name' => 'Leon', 'slug' => 'noel-leon']);

    // От юли: една квалификация без резултати (днес API-то дава две) и спринт
    // с вече показана класация, който в календара вече го няма.
    F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::Qualifying]);
    $sprint = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::SprintRace]);
    F2Result::create(['f2_race_session_id' => $sprint->id, 'f2_driver_id' => $driver->id, 'position' => 1]);

    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*/meetings*' => Http::response(f2Meeting([
            f2SessionV2('Qualifying', 1, ['state' => 'upcoming']),
            f2SessionV2('Qualifying', 2, ['state' => 'upcoming']),
        ])),
        'api.formula1.com/*' => Http::response(['standings' => []]),
    ]);

    app(F2ApiSync::class)->syncSeason(2026);

    expect(F2RaceSession::query()->pluck('session_type')->map(fn ($t) => $t->value)->sort()->values()->all())
        ->toBe(['qualifying_group_a', 'qualifying_group_b', 'sprint_race']);
});

it('не пипа разписанието и датата на кръга, когато не разпознае нито една сесия', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $race = F2Race::create([
        'f2_season_id' => $season->id, 'round' => 9, 'location_name' => 'Budapest', 'slug' => '2026-budapest',
        'race_datetime_utc' => '2026-07-26 09:25:00',
    ]);
    F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::FeatureRace]);

    // Пак сменени кодове: досега това нулираше датата на всеки кръг.
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*/meetings*' => Http::response(f2Meeting([
            f2SessionV2('Feature', 1, ['state' => 'upcoming']),
        ])),
        'api.formula1.com/*' => Http::response(['standings' => []]),
    ]);

    app(F2ApiSync::class)->syncSeason(2026);

    expect($race->fresh()->race_datetime_utc->toDateTimeString())->toBe('2026-07-26 09:25:00')
        ->and(F2RaceSession::query()->count())->toBe(1);
});

it('не показва като потвърден час, който API-то отбелязва с TBC', function () {
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*/meetings*' => Http::response(f2Meeting([
            // Лусаил 2026: правдоподобен кръгъл час, но sessionStatus „TBC".
            f2SessionV2('Race', 2, ['startTime' => '2026-11-29T12:00:00', 'state' => 'upcoming', 'sessionStatus' => 'TBC']),
            f2SessionV2('Race', 1, ['startTime' => '2026-11-28T13:15:00', 'state' => 'upcoming']),
        ])),
        'api.formula1.com/*' => Http::response(['standings' => []]),
    ]);

    app(F2ApiSync::class)->syncSeason(2026);

    expect(F2RaceSession::query()->where('session_type', F2SessionType::FeatureRace->value)->first()->time_tbc)->toBeTrue()
        ->and(F2RaceSession::query()->where('session_type', F2SessionType::SprintRace->value)->first()->time_tbc)->toBeFalse();
});

it('мести запълнителя „00:00 местно" на обяд, за да не падне в предишния ден', function () {
    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*/meetings*' => Http::response(f2Meeting([
            // Яс Марина 2026: 00:00 на 06.12 при +04:00 е 22:00 на 05.12 в София.
            f2SessionV2('Race', 2, [
                'startTime' => '2026-12-06T00:00:00', 'endTime' => '2026-12-06T01:00:00',
                'gmtOffset' => '+04:00', 'state' => 'upcoming', 'sessionStatus' => 'TBC',
            ]),
            // Мелбърн: потвърден час, 10:00 местно на 06.03 е 05.03 по UTC.
            f2SessionV2('Practice', 0, [
                'startTime' => '2026-03-06T10:00:00', 'endTime' => '2026-03-06T10:45:00',
                'gmtOffset' => '+11:00',
            ]),
        ])),
        'api.formula1.com/*' => Http::response(['sessionResults' => ['results' => []]]),
    ]);

    app(F2ApiSync::class)->syncSeason(2026);

    $feature = F2RaceSession::query()->where('session_type', F2SessionType::FeatureRace->value)->first();
    $practice = F2RaceSession::query()->where('session_type', F2SessionType::Practice->value)->first();

    expect($feature->scheduled_at_utc->toDateTimeString())->toBe('2026-12-06 08:00:00')
        ->and($feature->ends_at_utc->toDateTimeString())->toBe('2026-12-06 09:00:00')
        ->and($feature->date->toDateString())->toBe('2026-12-06')
        ->and($feature->time_tbc)->toBeTrue()
        ->and(F2Race::query()->first()->race_datetime_utc->toDateTimeString())->toBe('2026-12-06 08:00:00')
        // Потвърденият час не се пипа, а денят е софийският (01:00 на 06.03).
        ->and($practice->scheduled_at_utc->toDateTimeString())->toBe('2026-03-05 23:00:00')
        ->and($practice->date->toDateString())->toBe('2026-03-06');
});

it('предупреждава за непознат вид сесия, вместо да я пропусне тихо', function () {
    Log::spy();

    Http::fake([
        'www.fiaformula2.com/*' => Http::response(f2KeyPage()),
        'api.formula1.com/*/meetings*' => Http::response(f2Meeting([
            f2SessionV2('Race', 4, ['state' => 'upcoming']),
            f2SessionV2('Race', 2, ['state' => 'upcoming']),
        ])),
        'api.formula1.com/*' => Http::response(['standings' => []]),
    ]);

    $stats = app(F2ApiSync::class)->syncSeason(2026);

    expect($stats['sessions'])->toBe(1)
        ->and($stats['errors'])->toHaveCount(1)
        ->and($stats['errors'][0])->toContain('Race 4');

    Log::shouldHaveReceived('warning')
        ->withArgs(fn (string $message): bool => str_contains($message, 'Race 4'))
        ->once();
});
