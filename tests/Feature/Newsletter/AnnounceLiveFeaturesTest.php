<?php

declare(strict_types=1);

use App\Mail\LiveFeaturesAnnouncementMail;
use App\Models\F2Driver;
use App\Models\F2Season;
use App\Models\NewsletterSend;
use App\Models\NewsletterSubscriber;
use App\Models\Race;
use App\Models\Season;
use App\Models\User;
use App\Services\Tsolov\TsolovMeter;
use Illuminate\Support\Facades\Mail;

/*
 * Писмото за вълната „уикендът на живо". Праща се ръчно и веднъж — затова
 * пазачите (флагове, повторен пуск) тежат повече от самия текст.
 */

beforeEach(function () {
    Mail::fake();

    config([
        'features.live_predictions' => true,
        'features.tsolov' => true,
        'features.game' => true,
    ]);
});

function tsolovLeading(): void
{
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);

    F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Nikola', 'last_name' => 'Tsolov', 'slug' => 'nikola-tsolov',
        'position' => 1, 'points' => 177,
    ]);
    F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => 'Rafael', 'last_name' => 'Camara', 'slug' => 'rafael-camara',
        'position' => 2, 'points' => 170,
    ]);
}

it('праща на потребителите и на бюлетинните абонати', function () {
    $user = User::factory()->create();
    $subscriber = NewsletterSubscriber::create(['email' => 'abonat@example.bg', 'unsubscribe_token' => str_repeat('t', 48)]);

    $this->artisan('padok:announce-live')->assertSuccessful();

    Mail::assertSent(LiveFeaturesAnnouncementMail::class, 2);
    Mail::assertSent(LiveFeaturesAnnouncementMail::class, fn ($mail) => $mail->hasTo($user->email));
    Mail::assertSent(LiveFeaturesAnnouncementMail::class, fn ($mail) => $mail->hasTo($subscriber->email));
});

it('отказва при изключен раздел, вместо да води към 404', function () {
    User::factory()->create();

    foreach (['live_predictions', 'tsolov', 'game'] as $flag) {
        config(["features.{$flag}" => false]);

        $this->artisan('padok:announce-live')->assertFailed();

        config(["features.{$flag}" => true]);
    }

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('прескача банати и спрели имейлите потребители', function () {
    User::factory()->create(['banned_at' => now()]);
    User::factory()->create(['email_opt_out_at' => now()]);

    $this->artisan('padok:announce-live')->assertSuccessful();

    Mail::assertNothingSent();
});

it('не праща втори път при повторен пуск', function () {
    User::factory()->create();

    $this->artisan('padok:announce-live')->assertSuccessful();
    $this->artisan('padok:announce-live')->assertSuccessful();

    Mail::assertSent(LiveFeaturesAnnouncementMail::class, 1);
});

it('force пуска повторно', function () {
    User::factory()->create();

    $this->artisan('padok:announce-live')->assertSuccessful();
    $this->artisan('padok:announce-live', ['--force' => true])->assertSuccessful();

    Mail::assertSent(LiveFeaturesAnnouncementMail::class, 2);
});

it('dry-run не праща и не маркира', function () {
    User::factory()->create();

    $this->artisan('padok:announce-live', ['--dry-run' => true])->assertSuccessful();

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('носи живите числа на Цолов', function () {
    tsolovLeading();
    User::factory()->create();

    $this->artisan('padok:announce-live')->assertSuccessful();

    Mail::assertSent(LiveFeaturesAnnouncementMail::class, function ($mail) {
        return $mail->tsolov['leads'] === true
            && $mail->tsolov['points'] === 177.0
            && $mail->tsolov['rival']['gap'] === 7.0;
    });
});

it('скрива секцията за Цолов, когато няма синхронизиран сезон', function () {
    User::factory()->create();

    $this->artisan('padok:announce-live')->assertSuccessful();

    Mail::assertSent(LiveFeaturesAnnouncementMail::class, fn ($mail) => $mail->tsolov === null);
});

it('обещава писмото след кръга само при вдигнат флаг', function () {
    User::factory()->create();

    config(['features.race_result_mail' => false]);
    $this->artisan('padok:announce-live')->assertSuccessful();
    Mail::assertSent(LiveFeaturesAnnouncementMail::class, fn ($mail) => $mail->resultMailOn === false);

    config(['features.race_result_mail' => true]);
    $this->artisan('padok:announce-live', ['--force' => true])->assertSuccessful();
    Mail::assertSent(LiveFeaturesAnnouncementMail::class, fn ($mail) => $mail->resultMailOn === true);
});

it('сочи към следващия кръг с отворени прогнози', function () {
    $season = Season::factory()->create(['is_current' => true]);
    $race = Race::factory()->create([
        'season_id' => $season->id,
        'qualifying_datetime_utc' => now()->addDays(3),
        'race_datetime_utc' => now()->addDays(4),
    ]);

    User::factory()->create();

    $this->artisan('padok:announce-live')->assertSuccessful();

    Mail::assertSent(LiveFeaturesAnnouncementMail::class, fn ($mail) => $mail->nextRace !== null
        && str_contains($mail->nextRace['url'], (string) $race->id));
});

it('се рендира и за абонат без акаунт, без линк към прогноза', function () {
    tsolovLeading();

    $mail = new LiveFeaturesAnnouncementMail(
        tsolov: app(TsolovMeter::class)->summary(),
        nextRace: ['name' => 'Гран при на Азербайджан', 'url' => 'https://padok.bg/races/15', 'deadline' => '25.09.2026, 14:55 ч.'],
        resultMailOn: true,
        unsubscribeToken: str_repeat('t', 48),
    );

    $html = $mail->render();

    expect($html)->toContain('Включи се')
        // CTA-то към кръга е безполезно за човек без акаунт.
        ->not->toContain('Подай прогноза')
        // Обещанието за писмо след кръга важи само за прогнозиралите.
        ->not->toContain('вечерта след състезанието')
        ->toContain('Цолов');
});
