<?php

declare(strict_types=1);

use App\Enums\ChannelPostKind;
use App\Enums\ChannelPostStatus;
use App\Enums\ChannelQueueOutcome;
use App\Enums\F2SessionType;
use App\Models\ChannelPost;
use App\Models\F2Driver;
use App\Models\F2Race;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use App\Models\F2Team;
use App\Services\Telegram\ChannelPublisher;
use App\Services\Telegram\ChannelQueue;
use App\Services\Telegram\F2ChannelEnqueuer;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    config()->set('channel.enabled', true);
    config()->set('channel.post_sleep_ms', 0);
    config()->set('services.telegram.bot_token', 'test-token');
    config()->set('services.telegram.chat_id', '-100123');
});

function telegramOk(): void
{
    Http::fake(['api.telegram.org/*' => Http::response(['ok' => true, 'result' => ['message_id' => 55]])]);
}

function makeF2Session(F2SessionType $type, ?string $version = null, ?string $endsAt = null): F2RaceSession
{
    $season = F2Season::query()->create(['year' => 2026, 'is_current' => true]);
    $team = F2Team::query()->create(['f2_season_id' => $season->id, 'name' => 'Campos Racing', 'slug' => 'campos-racing']);
    $race = F2Race::query()->create([
        'f2_season_id' => $season->id, 'round' => 9, 'location_name' => 'Budapest',
        'country_name' => 'Hungary', 'slug' => '2026-budapest',
        'circuit_jolpica_id' => 'hungaroring',
    ]);

    $session = F2RaceSession::query()->create([
        'f2_race_id' => $race->id,
        'session_type' => $type->value,
        'state' => 'completed',
        'version' => $version,
        'ends_at_utc' => $endsAt ?? now()->subHour(),
    ]);

    $driver = F2Driver::query()->create([
        'f2_season_id' => $season->id, 'f2_team_id' => $team->id,
        'first_name' => 'Nikola', 'last_name' => 'Tsolov', 'slug' => 'nikola-tsolov',
    ]);

    F2Result::query()->create([
        'f2_race_session_id' => $session->id, 'f2_driver_id' => $driver->id,
        'position' => 1, 'time_or_gap' => '1:30.720', 'points' => 25,
    ]);

    return $session->fresh();
}

function pendingPost(string $body = '<b>Тест</b>'): ChannelPost
{
    return ChannelPost::query()->create([
        'channel' => 'telegram',
        'kind' => ChannelPostKind::F2Practice->value,
        'subject_type' => 'f2-session',
        'subject_id' => 1,
        'body' => $body,
    ]);
}

it('изпраща чакащата публикация и я маркира като изпратена', function () {
    telegramOk();
    $post = pendingPost();

    $stats = app(ChannelPublisher::class)->publish();

    expect($stats['sent'])->toBe(1);

    $post->refresh();

    expect($post->status)->toBe(ChannelPostStatus::Sent)
        ->and($post->telegram_message_id)->toBe(55)
        ->and($post->sent_at)->not->toBeNull();
});

it('не публикува същия ред втори път', function () {
    telegramOk();
    pendingPost();

    app(ChannelPublisher::class)->publish();
    Http::assertSentCount(1);

    app(ChannelPublisher::class)->publish();

    // Второто пускане не праща нищо — точно това пази канала от повторение
    // при почасовия синхрон.
    Http::assertSentCount(1);
});

it('не праща нищо, когато каналът е изключен', function () {
    config()->set('channel.enabled', false);
    Http::fake();
    pendingPost();

    $stats = app(ChannelPublisher::class)->publish();

    expect($stats['sent'])->toBe(0)
        ->and($stats['errors'])->not->toBeEmpty();

    Http::assertNothingSent();
});

it('не праща отложените публикации преди времето им', function () {
    telegramOk();
    $post = pendingPost();
    $post->update(['available_at' => now()->addHour()]);

    app(ChannelPublisher::class)->publish();

    Http::assertNothingSent();
    expect($post->fresh()->status)->toBe(ChannelPostStatus::Pending);
});

it('маркира постоянната грешка като провалена и не опитва пак', function () {
    Http::fake(['api.telegram.org/*' => Http::response(
        ['ok' => false, 'error_code' => 403, 'description' => 'Forbidden'], 403,
    )]);
    $post = pendingPost();

    app(ChannelPublisher::class)->publish();

    expect($post->fresh()->status)->toBe(ChannelPostStatus::Failed);

    app(ChannelPublisher::class)->publish();
    Http::assertSentCount(1);
});

it('оставя временната грешка за следващото пускане', function () {
    Http::fake(['api.telegram.org/*' => Http::response('', 500)]);
    $post = pendingPost();

    app(ChannelPublisher::class)->publish();
    $post->refresh();

    expect($post->status)->toBe(ChannelPostStatus::Pending)
        ->and($post->attempts)->toBe(1)
        ->and($post->last_error)->not->toBeNull();
});

it('се предава след изчерпване на опитите', function () {
    config()->set('channel.max_attempts', 2);
    Http::fake(['api.telegram.org/*' => Http::response('', 500)]);
    $post = pendingPost();

    app(ChannelPublisher::class)->publish();
    expect($post->fresh()->status)->toBe(ChannelPostStatus::Pending);

    app(ChannelPublisher::class)->publish();
    expect($post->fresh()->status)->toBe(ChannelPostStatus::Failed);
});

it('разбива дългия пост на няколко съобщения', function () {
    telegramOk();
    config()->set('channel.max_message_length', 100);

    $body = implode("\n", array_fill(0, 12, str_repeat('я', 40)));
    pendingPost($body);

    app(ChannelPublisher::class)->publish();

    expect(count(Http::recorded()))->toBeGreaterThan(1);
});

it('поставя в опашката най-много веднъж за тема и вид', function () {
    $session = makeF2Session(F2SessionType::Practice);
    $queue = app(ChannelQueue::class);

    expect($queue->enqueue($session, ChannelPostKind::F2Practice, 'тест'))
        ->toBe(ChannelQueueOutcome::Created)
        ->and($queue->enqueue($session, ChannelPostKind::F2Practice, 'тест'))
        ->toBe(ChannelQueueOutcome::Unchanged)
        ->and(ChannelPost::query()->count())->toBe(1);
});

it('поставя тренировката веднага', function () {
    makeF2Session(F2SessionType::Practice);

    expect(app(F2ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(1);
});

it('публикува временната класация, но я отбелязва като такава', function () {
    makeF2Session(F2SessionType::FeatureRace, version: 'Provisional');

    expect(app(F2ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(1)
        ->and(ChannelPost::query()->first()->body)->toContain('Временна класация');
});

it('не публикува състезание, докато резултатите не са свалени', function () {
    // version = null значи, че синхронът още не е стигнал до класацията.
    makeF2Session(F2SessionType::FeatureRace, version: null);

    expect(app(F2ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(0);
});

it('редактира вече изпратения пост, вместо да праща втори при окончателна класация', function () {
    telegramOk();
    $session = makeF2Session(F2SessionType::FeatureRace, version: 'Provisional');

    app(F2ChannelEnqueuer::class)->enqueuePending();
    app(ChannelPublisher::class)->publish();

    $post = ChannelPost::query()->first();

    expect($post->status)->toBe(ChannelPostStatus::Sent)
        ->and($post->telegram_message_id)->toBe(55);

    // Стюардите се произнасят: класацията става окончателна.
    $session->update(['version' => 'Final']);
    app(F2ChannelEnqueuer::class)->enqueuePending();

    $post->refresh();

    expect($post->status)->toBe(ChannelPostStatus::Pending)
        ->and($post->body)->not->toContain('Временна класация')
        // message_id се запазва — по него издателят разбира, че редактира.
        ->and($post->telegram_message_id)->toBe(55);

    app(ChannelPublisher::class)->publish();

    // Второто извикване е editMessageText, не sendMessage — иначе каналът би
    // получил втори пост и второ известие за едно и също събитие.
    Http::assertSent(fn ($request) => str_contains($request->url(), 'editMessageText')
        && $request['message_id'] === 55);

    expect(ChannelPost::query()->count())->toBe(1)
        ->and($post->fresh()->status)->toBe(ChannelPostStatus::Sent);
});

it('публикува състезанието, щом класацията стане окончателна', function () {
    makeF2Session(F2SessionType::FeatureRace, version: 'Final');

    expect(app(F2ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(1);
});

it('не наваксва сесии извън прозореца назад', function () {
    config()->set('channel.max_backfill_hours', 24);
    makeF2Session(F2SessionType::Practice, endsAt: now()->subDays(5)->toDateTimeString());

    // Иначе първото включване на канала би изсипало целия изминал сезон.
    expect(app(F2ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(0);
});

it('съставя четим пост с медал, отбор и време', function () {
    $session = makeF2Session(F2SessionType::Practice);

    app(F2ChannelEnqueuer::class)->enqueuePending();
    $body = ChannelPost::query()->first()->body;

    expect($body)->toContain('Формула 2 · Свободна тренировка')
        // Българското име на Гран при-то идва през връзката към F1 пистата;
        // сайтът е само на български и „Hungary" стърчи.
        ->and($body)->toContain('Гран при на Унгария · кръг 9')
        ->and($body)->toContain('🥇')
        ->and($body)->toContain('Никола Цолов')
        ->and($body)->toContain('Campos Racing')
        ->and($body)->toContain('1:30.720');
});

it('пише pole и под второто главно състезание (Баку 2026)', function () {
    $session = makeF2Session(F2SessionType::SecondFeatureRace, 'Final');
    F2RaceSession::query()->whereKey($session->id)->update(['pole_position_driver_id' => F2Driver::query()->value('id')]);

    app(F2ChannelEnqueuer::class)->enqueuePending();
    $body = ChannelPost::query()->first()->body;

    expect($body)->toContain('Формула 2 · Второ главно състезание')
        ->and($body)->toContain('От пол позиция: <b>Никола Цолов</b>');
});

it('дописва българския пилот, ако е извън първите десет', function () {
    $season = F2Season::query()->create(['year' => 2026, 'is_current' => true]);
    $race = F2Race::query()->create([
        'f2_season_id' => $season->id, 'round' => 9, 'location_name' => 'Budapest',
        'slug' => '2026-budapest', 'circuit_jolpica_id' => 'hungaroring',
    ]);
    $session = F2RaceSession::query()->create([
        'f2_race_id' => $race->id, 'session_type' => F2SessionType::Practice->value,
        'state' => 'completed', 'ends_at_utc' => now()->subHour(),
    ]);

    foreach (range(1, 14) as $position) {
        $isTsolov = $position === 14;

        $driver = F2Driver::query()->create([
            'f2_season_id' => $season->id,
            'first_name' => $isTsolov ? 'Nikola' : "Driver{$position}",
            'last_name' => $isTsolov ? 'Tsolov' : 'Test',
            'slug' => $isTsolov ? 'nikola-tsolov' : "driver{$position}-test",
        ]);

        F2Result::query()->create([
            'f2_race_session_id' => $session->id, 'f2_driver_id' => $driver->id, 'position' => $position,
        ]);
    }

    app(F2ChannelEnqueuer::class)->enqueuePending();
    $body = ChannelPost::query()->first()->body;

    // Класацията реже на 10, но заради Цолов се отваря постът — без него
    // отговорът на въпроса, довел човека тук, липсва.
    expect($body)->toContain('🇧🇬')
        ->and($body)->toContain('Никола Цолов')
        ->and($body)->toContain('14-и');
});

it('публикува сесиите в хронологичен ред, не по реда на вмъкване', function () {
    // Наваксването може да вмъкне състезанието първо (планировчикът го е
    // хванал по-рано от останалите). Без подредба по време на сесията каналът
    // би обявил резултата преди квалификацията.
    $season = F2Season::query()->create(['year' => 2026, 'is_current' => true]);
    $race = F2Race::query()->create([
        'f2_season_id' => $season->id, 'round' => 9, 'location_name' => 'Budapest', 'slug' => '2026-budapest',
    ]);

    $driver = F2Driver::query()->create([
        'f2_season_id' => $season->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov', 'slug' => 'nikola-tsolov',
    ]);

    $create = function (F2SessionType $type, string $endsAt) use ($race, $driver): F2RaceSession {
        $session = F2RaceSession::query()->create([
            'f2_race_id' => $race->id,
            'session_type' => $type->value,
            'state' => 'completed',
            'version' => $type->isRace() ? 'Final' : null,
            'ends_at_utc' => $endsAt,
        ]);

        F2Result::query()->create([
            'f2_race_session_id' => $session->id, 'f2_driver_id' => $driver->id, 'position' => 1,
        ]);

        return $session;
    };

    // Нарочно вмъкнати наопаки.
    $create(F2SessionType::FeatureRace, now()->subHours(2)->toDateTimeString());
    $create(F2SessionType::Practice, now()->subHours(10)->toDateTimeString());
    $create(F2SessionType::Qualifying, now()->subHours(8)->toDateTimeString());

    app(F2ChannelEnqueuer::class)->enqueuePending();

    expect(ChannelPost::query()->ready()->pluck('kind')->map(fn ($k) => $k->value)->all())
        ->toBe(['f2_practice', 'f2_qualifying', 'f2_feature_race']);
});

it('праща наново, ако оригиналното съобщение е изтрито от канала', function () {
    Http::fake(['api.telegram.org/*' => Http::sequence()
        ->push(['ok' => true, 'result' => ['message_id' => 55]], 200)
        // Telegram отговаря така, когато съобщението вече не съществува.
        ->push(['ok' => false, 'error_code' => 400, 'description' => 'Bad Request: MESSAGE_ID_INVALID'], 400)
        ->push(['ok' => true, 'result' => ['message_id' => 77]], 200),
    ]);

    $session = makeF2Session(F2SessionType::FeatureRace, version: 'Provisional');

    app(F2ChannelEnqueuer::class)->enqueuePending();
    app(ChannelPublisher::class)->publish();

    $session->update(['version' => 'Final']);
    app(F2ChannelEnqueuer::class)->enqueuePending();
    app(ChannelPublisher::class)->publish();

    // Провалената редакция не бива да убива поста завинаги — по-добре нов
    // пост, отколкото такъв, който остава грешен.
    $post = ChannelPost::query()->first();

    expect($post->status)->toBe(ChannelPostStatus::Sent)
        ->and($post->telegram_message_id)->toBe(77);
});

it('връща провалените публикации в опашката с --retry-failed', function () {
    telegramOk();
    $post = pendingPost();
    $post->update(['status' => ChannelPostStatus::Failed->value, 'attempts' => 5]);

    $this->artisan('channel:post --retry-failed')->assertSuccessful();

    $post->refresh();

    // Опитите се нулират — инак таванът от предишния провал спира веднага.
    expect($post->status)->toBe(ChannelPostStatus::Sent)
        ->and($post->attempts)->toBe(1);
});

it('не показва измислен час за сесия с необявено разписание', function () {
    $session = makeF2Session(F2SessionType::FeatureRace, version: 'Final');

    // Следващият кръг идва от API-то с 00:00 местно време — запълнител.
    // В софийско това става 01:00, час, в който F2 не кара.
    $nextRace = F2Race::query()->create([
        'f2_season_id' => $session->race->f2_season_id, 'round' => 10,
        'location_name' => 'Monza', 'slug' => '2026-monza',
    ]);

    F2RaceSession::query()->create([
        'f2_race_id' => $nextRace->id,
        'session_type' => F2SessionType::Practice->value,
        'scheduled_at_utc' => now()->addDays(40)->startOfDay(),
        'time_tbc' => true,
        'state' => 'upcoming',
    ]);

    app(F2ChannelEnqueuer::class)->enqueuePending();
    $body = ChannelPost::query()->first()->body;

    expect($body)->toContain('Свободна тренировка, кръг 10')
        ->and($body)->not->toContain('01:00');
});

it('избира следващата сесия по реда на уикенда при еднакво време', function () {
    $session = makeF2Session(F2SessionType::FeatureRace, version: 'Final');
    $nextRace = F2Race::query()->create([
        'f2_season_id' => $session->race->f2_season_id, 'round' => 10,
        'location_name' => 'Monza', 'slug' => '2026-monza',
    ]);

    // И двете с еднакво време — SQL подредбата ги разбърква и постът обявяваше
    // квалификацията преди тренировката.
    foreach ([F2SessionType::Qualifying, F2SessionType::Practice] as $type) {
        F2RaceSession::query()->create([
            'f2_race_id' => $nextRace->id,
            'session_type' => $type->value,
            'scheduled_at_utc' => now()->addDays(40)->startOfDay(),
            'time_tbc' => true,
            'state' => 'upcoming',
        ]);
    }

    app(F2ChannelEnqueuer::class)->enqueuePending();

    expect(ChannelPost::query()->first()->body)->toContain('Свободна тренировка, кръг 10');
});

it('праща тренировките без звук', function () {
    telegramOk();
    $session = makeF2Session(F2SessionType::Practice);
    app(F2ChannelEnqueuer::class)->enqueuePending();

    app(ChannelPublisher::class)->publish();

    Http::assertSent(fn ($request) => $request['disable_notification'] === true);
});

it('всеки вид пост има етикет, серия и тип сесия без изключение', function () {
    // label() и series() са match без default: нов case без ред тук хвърля
    // UnhandledMatchError чак когато някой отвори опашката с --preview.
    // Този тест го хваща при добавянето, а не месеци по-късно.
    foreach (ChannelPostKind::cases() as $kind) {
        expect($kind->label())->toBeString()->not->toBeEmpty()
            ->and(fn () => $kind->series())->not->toThrow(Throwable::class)
            ->and(fn () => $kind->sessionType())->not->toThrow(Throwable::class)
            ->and($kind->requiresOpenF1Attribution())->toBeBool()
            ->and($kind->showsLinkPreview())->toBeBool()
            ->and($kind->isSilent())->toBeBool();
    }
});
