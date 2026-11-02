<?php

declare(strict_types=1);

use App\Enums\ResultSessionType;
use App\Enums\SessionType;
use App\Models\Constructor;
use App\Models\Driver;
use App\Models\Race;
use App\Models\Result;
use App\Models\Season;
use App\Models\SessionResult;
use App\Services\LiveTiming\OpenF1SessionSync;
use App\Services\Standings\StandingsService;
use Illuminate\Http\Client\ResponseSequence;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Inertia\Testing\AssertableInertia as Assert;

/*
 * FP1 в Мексико 2026 — първата официална сесия на българин във Формула 1.
 *
 * Фикстурите са истинският отговор на OpenF1 (session_key 11397). От 22-мата
 * карали 13 са в ростъра с номер. Шестима са резерви, които Jolpica е внесла
 * без номер, код и отбор. Цолов, Мини и Слейтър ги няма изобщо.
 */

beforeEach(function () {
    // Съботата на уикенда: FP1 е приключила, състезанието още не е. Синхронът
    // взима само приключили сесии, а фикстурите са с истинските дати.
    $this->travelTo(Carbon::parse('2026-10-31 12:00:00', 'UTC'));
});

/**
 * @return array<int, array<string, mixed>>
 */
function mexicoFp1Fixture(string $name): array
{
    return json_decode(
        file_get_contents(base_path("tests/Fixtures/openf1/mexico-2026-fp1-{$name}.json")),
        true,
    );
}

/**
 * @param  array<int, array<string, mixed>>|null  $drivers
 */
function fakeMexicoFp1(?array $drivers = null, ?ResponseSequence $results = null): void
{
    Http::fake([
        // Състезанието трябва да е в списъка: по неговата дата синхронът
        // намира кръга, а FP1 е повече от два дни по-рано.
        'api.openf1.org/v1/sessions*' => Http::response([
            [
                'session_key' => 11397,
                'meeting_key' => 1298,
                'session_name' => 'Practice 1',
                'date_start' => '2026-10-30T18:30:00+00:00',
                'date_end' => '2026-10-30T19:30:00+00:00',
                'is_cancelled' => false,
            ],
            [
                'session_key' => 11405,
                'meeting_key' => 1298,
                'session_name' => 'Race',
                'date_start' => '2026-11-01T20:00:00+00:00',
                'date_end' => '2026-11-01T22:00:00+00:00',
                'is_cancelled' => false,
            ],
        ]),
        'api.openf1.org/v1/session_result*' => $results ?? Http::response(mexicoFp1Fixture('session-result')),
        'api.openf1.org/v1/drivers*' => Http::response($drivers ?? mexicoFp1Fixture('drivers')),
    ]);
}

/**
 * Ростърът от прода в деня на FP1: титулярите с номер, код и отбор от
 * Jolpica и резервите, които Jolpica внася без нито едно от трите.
 */
function seedMexicoRoster(): Race
{
    $season = Season::factory()->create(['year' => 2026, 'is_current' => true]);

    // Имената и jolpica_id са като в прода — по тях се превеждат отборите от OpenF1.
    $teams = collect([
        'Ferrari' => 'ferrari', 'Mercedes' => 'mercedes', 'Red Bull' => 'red_bull',
        'RB F1 Team' => 'rb', 'Alpine F1 Team' => 'alpine', 'Aston Martin' => 'aston_martin',
        'McLaren' => 'mclaren', 'Haas F1 Team' => 'haas', 'Audi' => 'audi',
        'Williams' => 'williams', 'Cadillac F1 Team' => 'cadillac',
    ])->map(fn (string $jolpicaId, string $name): Constructor => Constructor::factory()->create([
        'season_id' => $season->id,
        'jolpica_id' => $jolpicaId,
        'name' => $name,
        'slug' => Str::slug($name),
    ]));

    $regulars = [
        ['Charles', 'Leclerc', 16, 'LEC', 'Ferrari'],
        ['Lewis', 'Hamilton', 44, 'HAM', 'Ferrari'],
        ['Andrea Kimi', 'Antonelli', 12, 'ANT', 'Mercedes'],
        ['George', 'Russell', 63, 'RUS', 'Mercedes'],
        ['Isack', 'Hadjar', 6, 'HAD', 'Red Bull'],
        ['Max', 'Verstappen', 3, 'VER', 'Red Bull'],
        ['Arvid', 'Lindblad', 41, 'LIN', 'RB F1 Team'],
        ['Liam', 'Lawson', 30, 'LAW', 'RB F1 Team'],
        ['Pierre', 'Gasly', 10, 'GAS', 'Alpine F1 Team'],
        ['Franco', 'Colapinto', 43, 'COL', 'Alpine F1 Team'],
        ['Fernando', 'Alonso', 14, 'ALO', 'Aston Martin'],
        ['Lance', 'Stroll', 18, 'STR', 'Aston Martin'],
        ['Oscar', 'Piastri', 81, 'PIA', 'McLaren'],
        ['Lando', 'Norris', 1, 'NOR', 'McLaren'],
        ['Oliver', 'Bearman', 87, 'BEA', 'Haas F1 Team'],
        ['Ryo', 'Hirakawa', 50, 'HIR', 'Haas F1 Team'],
        ['Nico', 'Hülkenberg', 27, 'HUL', 'Audi'],
        ['Gabriel', 'Bortoleto', 5, 'BOR', 'Audi'],
        ['Carlos', 'Sainz', 55, 'SAI', 'Williams'],
        ['Alexander', 'Albon', 23, 'ALB', 'Williams'],
        ['Sergio', 'Pérez', 11, 'PER', 'Cadillac F1 Team'],
        ['Valtteri', 'Bottas', 77, 'BOT', 'Cadillac F1 Team'],
    ];

    foreach ($regulars as [$first, $last, $number, $code, $team]) {
        Driver::factory()->create([
            'season_id' => $season->id,
            'constructor_id' => $teams[$team]->id,
            'jolpica_id' => Str::slug($last, '_'),
            'first_name' => $first,
            'last_name' => $last,
            'slug' => Str::slug("{$first} {$last}"),
            'permanent_number' => $number,
            'driver_code' => $code,
        ]);
    }

    $reserves = [
        ['Frederik', 'Vesti'], ['Ayumu', 'Iwasa'], ['Leonardo', 'Fornaroli'], ['Jak', 'Crawford'],
        ['Luke', 'Browning'], ['Colton', 'Herta'], ['Paul', 'Aron'], ['Dino', 'Beganovic'],
    ];

    foreach ($reserves as [$first, $last]) {
        Driver::factory()->create([
            'season_id' => $season->id,
            'constructor_id' => null,
            'jolpica_id' => Str::slug("{$first} {$last}", '_'),
            'first_name' => $first,
            'last_name' => $last,
            'slug' => Str::slug("{$first} {$last}"),
            'permanent_number' => null,
            'driver_code' => null,
        ]);
    }

    return Race::factory()->create([
        'season_id' => $season->id,
        'jolpica_id' => 'rodriguez',
        'name' => 'Mexico City Grand Prix',
        'round' => 20,
        'race_datetime_utc' => '2026-11-01 20:00:00',
    ]);
}

it('показва всичките 22 от FP1 в Мексико, с Цолов 12-и', function () {
    $race = seedMexicoRoster();
    fakeMexicoFp1();

    app(OpenF1SessionSync::class)->syncSeason(2026);

    $rows = SessionResult::query()
        ->where('race_id', $race->id)
        ->where('session_type', SessionType::FP1->value)
        ->orderBy('position')
        ->get();

    // Досега: 13 реда и позиции 1, 2, 4, 6…
    expect($rows)->toHaveCount(22)
        ->and($rows->pluck('position')->all())->toBe(range(1, 22));

    $tsolov = $rows->firstWhere('driver_number', 91);

    // Новакът не влиза в ростъра на лигата — редът сам казва кой е карал.
    expect($tsolov->driver_id)->toBeNull()
        ->and($tsolov->driver_name)->toBe('Nikola Tsolov')
        ->and($tsolov->team_name)->toBe('RB F1 Team')
        ->and($tsolov->position)->toBe(12)
        ->and($tsolov->best_time)->toBe('1:19.604')
        ->and($tsolov->gap)->toBe('+1.476');

    // OpenF1 пише „Racing Bulls", „Alpine", „Cadillac"… Всеки ред трябва да е с
    // името на отбора, както го пише сайтът, иначе съотборниците се разминават.
    expect($rows->pluck('team_name')->unique()->diff(Constructor::query()->pluck('name')))->toBeEmpty();

    $this->get("/races/{$race->id}")
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('classifications.0.type', 'fp1')
            ->has('classifications.0.rows', 22)
            ->where('classifications.0.rows.11.position', 12)
            ->where('classifications.0.rows.11.driver', 'Никола Цолов')
            // Страница за пилот извън ростъра няма — редът е без линк.
            ->where('classifications.0.rows.11.slug', null)
            ->where('classifications.0.rows.11.team', 'RB F1 Team')
            ->where('classifications.0.rows.11.time', '1:19.604')
            ->where('classifications.0.rows.11.gap', '+1.476'));
});

it('връзва по име резервите, които Jolpica е внесла без номер', function () {
    $race = seedMexicoRoster();
    fakeMexicoFp1();

    app(OpenF1SessionSync::class)->syncSeason(2026);

    $vesti = Driver::query()->where('slug', 'frederik-vesti')->sole();
    $row = SessionResult::query()->where('driver_number', 72)->sole();

    expect($row->driver_id)->toBe($vesti->id)
        // Резервата няма отбор в ростъра — взима го от съотборника си в сесията.
        ->and($row->team_name)->toBe('Mercedes')
        // Изобщо липсват само тримата, които ги няма и сред резервите.
        ->and(SessionResult::query()->whereNull('driver_id')->orderBy('driver_number')->pluck('driver_number')->all())
        ->toBe([62, 91, 98]);

    $this->get("/races/{$race->id}")
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('classifications.0.rows.2.driver', 'Frederik Vesti')
            ->where('classifications.0.rows.2.slug', 'frederik-vesti')
            ->where('classifications.0.rows.2.team', 'Mercedes'));
});

it('не пипа ростъра, прогнозите и класиранията', function () {
    $race = seedMexicoRoster();

    Result::factory()->create([
        'race_id' => $race->id,
        'driver_id' => Driver::query()->where('slug', 'charles-leclerc')->value('id'),
        'session_type' => ResultSessionType::Race->value,
        'position' => 1,
        'points' => 25,
    ]);

    $standings = fn (): array => app(StandingsService::class)->drivers($race->season)
        ->map(fn (array $row): array => [$row['driver']->id, $row['points']])
        ->all();

    $drivers = Driver::query()->count();
    $results = Result::query()->count();
    $standingsBefore = $standings();

    fakeMexicoFp1();
    app(OpenF1SessionSync::class)->syncSeason(2026);

    expect(SessionResult::query()->count())->toBe(22)
        ->and(Driver::query()->count())->toBe($drivers)
        ->and(Result::query()->count())->toBe($results)
        ->and($standings())->toBe($standingsBefore);

    // Формата за прогноза предлага само ростъра — новаците не стават избираеми.
    $options = collect($this->get("/races/{$race->id}")->assertOk()->inertiaProps('drivers'));

    expect($options)->toHaveCount($drivers)
        ->and($options->pluck('name')->intersect(['Никола Цолов', 'Габриеле Мини', 'Freddie Slater']))->toBeEmpty();
});

it('повторният синхрон не дублира никого', function () {
    seedMexicoRoster();
    fakeMexicoFp1();

    app(OpenF1SessionSync::class)->syncSeason(2026);
    $ids = SessionResult::query()->orderBy('id')->pluck('id')->all();

    $stats = app(OpenF1SessionSync::class)->syncSeason(2026);

    // Грешките се гълтат в $stats, а unique индексите така или иначе спират
    // дубликатите — без тази проверка счупен синхрон изглежда идемпотентен.
    expect($stats['errors'])->toBe([])
        ->and($stats['results'])->toBe(22)
        ->and($ids)->toHaveCount(22)
        ->and(SessionResult::query()->orderBy('id')->pluck('id')->all())->toBe($ids);
});

it('повторният синхрон обновява на място и редовете извън ростъра', function () {
    seedMexicoRoster();

    // Стюардите изтриват обиколка на Цолов и той пада зад Хюлкенберг.
    $revised = collect(mexicoFp1Fixture('session-result'))
        ->map(fn (array $row): array => match ($row['driver_number']) {
            91 => [...$row, 'position' => 13, 'duration' => 79.7, 'gap_to_leader' => 1.572],
            27 => [...$row, 'position' => 12],
            default => $row,
        })
        ->all();

    fakeMexicoFp1(results: Http::sequence()
        ->push(mexicoFp1Fixture('session-result'))
        ->push($revised));

    app(OpenF1SessionSync::class)->syncSeason(2026);
    $ids = SessionResult::query()->orderBy('id')->pluck('id')->all();

    // Клиентът пази класацията 6 часа — без това вторият синхрон не я тегли.
    Cache::flush();
    $stats = app(OpenF1SessionSync::class)->syncSeason(2026);

    $tsolov = SessionResult::query()->where('driver_number', 91)->sole();

    expect($stats['errors'])->toBe([])
        ->and(SessionResult::query()->orderBy('id')->pluck('id')->all())->toBe($ids)
        ->and($tsolov->position)->toBe(13)
        ->and($tsolov->best_time)->toBe('1:19.700')
        ->and($tsolov->gap)->toBe('+1.572')
        ->and(SessionResult::query()->where('driver_number', 27)->sole()->position)->toBe(12);
});

it('пилот, чийто номер в ростъра се смени, не блокира синхрона', function () {
    seedMexicoRoster();
    fakeMexicoFp1();

    app(OpenF1SessionSync::class)->syncSeason(2026);

    // Грешен номер в ростъра: на Крауфорд (#34, P19) записват #72 — болида на
    // Вести (P3). Номерът печели, а P3 се записва преди P19, докато Крауфорд
    // още държи стария си ред.
    $crawford = Driver::query()->where('slug', 'jak-crawford')->sole();
    $crawford->update(['permanent_number' => 72]);

    $stats = app(OpenF1SessionSync::class)->syncSeason(2026);

    expect($stats['errors'])->toBe([])
        ->and(SessionResult::query()->count())->toBe(22)
        ->and(SessionResult::query()->where('driver_number', 72)->sole()->driver_id)->toBe($crawford->id)
        ->and(SessionResult::query()->where('driver_number', 34)->sole()->driver_id)->toBeNull();

    // Поправката в ростъра оправя и класацията на следващия синхрон.
    $crawford->update(['permanent_number' => null]);

    $stats = app(OpenF1SessionSync::class)->syncSeason(2026);

    expect($stats['errors'])->toBe([])
        ->and(SessionResult::query()->where('driver_number', 72)->sole()->driver_id)
        ->toBe(Driver::query()->where('slug', 'frederik-vesti')->value('id'))
        ->and(SessionResult::query()->where('driver_number', 34)->sole()->driver_id)->toBe($crawford->id);
});

it('отборът идва от името в OpenF1, а не от съотборник, сменил отбора си', function () {
    seedMexicoRoster();

    // Като Лоусън в Монца: съотборникът на Иваса в тази сесия вече е в друг
    // отбор според ростъра.
    Driver::query()->where('slug', 'isack-hadjar')->update([
        'constructor_id' => Constructor::query()->where('name', 'RB F1 Team')->value('id'),
    ]);

    fakeMexicoFp1();
    app(OpenF1SessionSync::class)->syncSeason(2026);

    // Иваса е резерва без отбор в ростъра; „Red Bull Racing" в OpenF1 е нашият „Red Bull".
    expect(SessionResult::query()->where('driver_number', 36)->sole()->team_name)->toBe('Red Bull');
});

it('новак, който по-късно влезе в ростъра, запазва реда си', function () {
    $race = seedMexicoRoster();
    fakeMexicoFp1();

    app(OpenF1SessionSync::class)->syncSeason(2026);
    $before = SessionResult::query()->where('driver_number', 91)->sole();

    // Например ако замести титуляр в състезание и Jolpica го внесе с номера му.
    $tsolov = Driver::factory()->create([
        'season_id' => $race->season_id,
        'constructor_id' => Constructor::query()->where('name', 'RB F1 Team')->value('id'),
        'first_name' => 'Nikola',
        'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov',
        'permanent_number' => 91,
        'driver_code' => 'TSO',
    ]);

    $stats = app(OpenF1SessionSync::class)->syncSeason(2026);
    $after = SessionResult::query()->where('driver_number', 91)->sole();

    expect($stats['errors'])->toBe([])
        ->and(SessionResult::query()->count())->toBe(22)
        ->and($after->id)->toBe($before->id)
        ->and($after->driver_id)->toBe($tsolov->id);
});

it('допълва номера на редовете отпреди миграцията, вместо да ги дублира', function () {
    $race = seedMexicoRoster();

    // Така изглеждат 13-те реда на прода: пилот от ростъра, без номер.
    $old = SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::FP1->value,
        'driver_id' => Driver::query()->where('slug', 'charles-leclerc')->value('id'),
        'position' => 1,
        'best_time' => '1:18.128',
        'source' => 'openf1',
    ]);

    fakeMexicoFp1();
    app(OpenF1SessionSync::class)->syncSeason(2026);

    expect(SessionResult::query()->count())->toBe(22)
        ->and($old->fresh()->driver_number)->toBe(16)
        ->and($old->fresh()->driver_name)->toBe('Charles Leclerc');
});

it('прескача пилот извън ростъра, щом OpenF1 не е дал имената', function () {
    seedMexicoRoster();
    fakeMexicoFp1(drivers: []);

    app(OpenF1SessionSync::class)->syncSeason(2026);

    // Титулярите се намират и само по номер. За останалите не знаем кой е
    // карал — по-добре да липсват до следващия синхрон, отколкото „№91".
    expect(SessionResult::query()->count())->toBe(13)
        ->and(SessionResult::query()->whereNull('driver_id')->exists())->toBeFalse();
});

it('новак със същия код като титуляр не презаписва реда на титуляра', function () {
    seedMexicoRoster();

    $drivers = collect(mexicoFp1Fixture('drivers'))
        ->map(fn (array $driver): array => $driver['driver_number'] === 91
            ? [...$driver, 'name_acronym' => 'LIN']
            : $driver)
        ->all();

    fakeMexicoFp1($drivers);
    app(OpenF1SessionSync::class)->syncSeason(2026);

    $lindblad = Driver::query()->where('slug', 'arvid-lindblad')->sole();

    // Номерът вече е намерил Линдблад, затова съвпадащият код не му взима реда.
    expect(SessionResult::query()->where('driver_id', $lindblad->id)->sole()->position)->toBe(10)
        ->and(SessionResult::query()->where('driver_number', 91)->sole()->driver_id)->toBeNull();
});
