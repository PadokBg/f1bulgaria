<?php

declare(strict_types=1);

use App\Services\LiveTiming\OpenF1Client;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    Cache::flush(); // кешът на клиента да не преплита тестовете
});

function client(): OpenF1Client
{
    return app(OpenF1Client::class);
}

it('разпознава текущата сесия', function () {
    Http::fake(['*/sessions*' => Http::response([[
        'session_key' => 9999,
        'session_name' => 'Qualifying',
        'session_type' => 'Qualifying',
        'date_start' => '2026-06-06T14:00:00+00:00',
        'date_end' => '2026-06-06T15:00:00+00:00',
        'meeting_key' => 1234,
        'circuit_short_name' => 'Monaco',
    ]])]);

    $session = client()->getCurrentSession();

    expect($session)->not->toBeNull()
        ->and($session['key'])->toBe(9999)
        ->and($session['name'])->toBe('Qualifying')
        ->and($session['circuit_short_name'])->toBe('Monaco')
        ->and($session['date_start']?->format('H:i'))->toBe('14:00');
});

it('връща null за текуща сесия при празен отговор', function () {
    Http::fake(['*/sessions*' => Http::response([])]);

    expect(client()->getCurrentSession())->toBeNull();
});

it('парсва пилотите със #-префикс на цвета', function () {
    Http::fake(['*/drivers*' => Http::response([
        ['driver_number' => 1, 'name_acronym' => 'VER', 'full_name' => 'Max Verstappen', 'team_name' => 'Red Bull', 'team_colour' => '3671C6'],
        ['driver_number' => 44, 'name_acronym' => 'HAM', 'full_name' => 'Lewis Hamilton', 'team_name' => 'Ferrari', 'team_colour' => 'E8002D'],
        ['invalid' => 'no driver_number'],
    ])]);

    $drivers = client()->getSessionDrivers(9999);

    expect($drivers)->toHaveCount(2)
        ->and($drivers->first()['name_acronym'])->toBe('VER')
        ->and($drivers->first()['team_colour'])->toBe('#3671C6');
});

it('парсва обиколките', function () {
    Http::fake(['*/laps*' => Http::response([
        ['driver_number' => 1, 'lap_number' => 5, 'lap_duration' => 72.345],
        ['driver_number' => 44, 'lap_number' => 5, 'lap_duration' => 72.901],
        ['missing_driver' => true],
    ])]);

    expect(client()->getLatestLaps(9999))->toHaveCount(2);
});

it('парсва позициите и пропуска редовете без позиция', function () {
    Http::fake(['*/position*' => Http::response([
        ['driver_number' => 1, 'position' => 1, 'date' => '2026-07-26T13:20:00+00:00'],
        ['driver_number' => 44, 'position' => 2, 'date' => '2026-07-26T13:20:00+00:00'],
        ['driver_number' => 16, 'date' => '2026-07-26T13:20:00+00:00'],
    ])]);

    expect(client()->getPositions(9999))->toHaveCount(2);
});

it('дърпа само последните минути интервали (иначе са десетки хиляди записа)', function () {
    Http::fake(['*/intervals*' => Http::response([
        ['driver_number' => 44, 'gap_to_leader' => 5.123, 'date' => '2026-07-26T13:20:04+00:00'],
    ])]);

    expect(client()->getIntervals(9999))->toHaveCount(1);

    Http::assertSent(function ($request) {
        // OpenF1 носи оператора в името на параметъра: „date>“ (URL-кодирано).
        return str_contains($request->url(), '/intervals')
            && str_contains($request->url(), 'date%3E=')
            && str_contains($request->url(), 'session_key=9999');
    });
});

it('връща празна колекция при timeout (graceful)', function () {
    Http::fake(fn () => throw new ConnectionException('timeout'));

    expect(client()->getLatestLaps(9999))->toBeEmpty()
        ->and(client()->getSessionDrivers(9999))->toBeEmpty()
        ->and(client()->getCurrentSession())->toBeNull();
});

it('връща празна колекция при HTTP 500 (graceful)', function () {
    Http::fake(['*' => Http::response('error', 500)]);

    expect(client()->getStints(9999))->toBeEmpty()
        ->and(client()->getCurrentSession())->toBeNull();
});

it('праща OAuth Bearer токен когато има кредитали (за живи сесии)', function () {
    config(['services.openf1.username' => 'u@x.bg', 'services.openf1.password' => 'p']);
    Http::fake([
        '*/token' => Http::response(['access_token' => 'oauth-token', 'expires_in' => 3600]),
        '*/laps*' => Http::response([['driver_number' => 1, 'lap_number' => 1]]),
    ]);

    client()->getLatestLaps(9999);

    Http::assertSent(fn ($request) => str_contains($request->url(), '/laps')
        && $request->hasHeader('Authorization', 'Bearer oauth-token'));
});

it('НЕ праща Authorization когато няма кредитали', function () {
    config(['services.openf1.username' => null, 'services.openf1.password' => null]);
    Http::fake(['*/laps*' => Http::response([])]);

    client()->getLatestLaps(9999);

    Http::assertSent(fn ($request) => ! $request->hasHeader('Authorization'));
});

it('праща оператора в името на параметъра, без да го кодира двойно', function () {
    Http::fake(['*car_data*' => Http::response([])]);

    client()->getCarData(
        11361,
        12,
        Carbon::parse('2026-09-06T14:53:23+00:00'),
        Carbon::parse('2026-09-06T14:54:47+00:00'),
    );

    Http::assertSent(function ($request) {
        $url = urldecode((string) $request->url());

        // http_build_query превръщаше „date>=" в „date%3E%3D=" — с още едно
        // кодирано равно — и OpenF1 връщаше 404. Заявката трябва да носи
        // оператора точно веднъж.
        return str_contains($url, 'date>=2026-09-06T14:53:23Z')
            && str_contains($url, 'date<=2026-09-06T14:54:47Z')
            && ! str_contains($url, '>==');
    });
});

it('превежда часовете в UTC, преди да ги прати', function () {
    Http::fake(['*location*' => Http::response([])]);

    client()->getLocation(
        11361,
        12,
        Carbon::parse('2026-09-06T17:53:23+03:00'),
        Carbon::parse('2026-09-06T17:54:47+03:00'),
    );

    // Софийско 17:53 е 14:53 UTC. Часовата зона не бива да се качва в „+",
    // защото в query низ това значи интервал.
    Http::assertSent(fn ($request) => str_contains(urldecode((string) $request->url()), 'date>=2026-09-06T14:53:23Z'));
});

it('повтаря при 429 и се отказва след третия опит', function () {
    Http::fake(['*stints*' => Http::response('rate limited', 429)]);

    expect(client()->getFinishedStints(11361))->toBeEmpty();

    // Три опита общо — повече само удължават агонията.
    Http::assertSentCount(3);
});

it('не пази провала: празният отговор се помни само минута', function () {
    Http::fake(['*/session_result*' => Http::sequence()
        ->push('error', 500)
        ->push([['driver_number' => 1, 'position' => 1]])]);

    expect(client()->getSessionResult(9999))->toBeEmpty()
        // Веднага след провала — без нова заявка към OpenF1.
        ->and(client()->getSessionResult(9999))->toBeEmpty();
    Http::assertSentCount(1);

    $this->travel(61)->seconds();

    expect(client()->getSessionResult(9999))->toHaveCount(1);
    Http::assertSentCount(2);
});

it('не вярва на празен отговор, кеширан по стария начин', function () {
    // Така Cache::remember пазеше провала — до 6 часа.
    Cache::put('openf1:session-result:9999', collect(), now()->addHours(6));
    Http::fake(['*/session_result*' => Http::response([['driver_number' => 91, 'position' => 12]])]);

    expect(client()->getSessionResult(9999))->toHaveCount(1);
});

it('пази пилотите на приключила сесия седмица', function () {
    Http::fake(['*/drivers*' => Http::response([
        ['driver_number' => 91, 'name_acronym' => 'TSO', 'first_name' => 'Nikola', 'last_name' => 'Tsolov', 'team_name' => 'Racing Bulls'],
    ])]);

    client()->getFinishedSessionDrivers(9999);
    $this->travel(3)->days();

    expect(client()->getFinishedSessionDrivers(9999)->first()['last_name'])->toBe('Tsolov');
    Http::assertSentCount(1);
});

it('не повтаря при 404 — то няма да се оправи от само себе си', function () {
    Http::fake(['*stints*' => Http::response('not found', 404)]);

    expect(client()->getFinishedStints(11361))->toBeEmpty();

    Http::assertSentCount(1);
});
