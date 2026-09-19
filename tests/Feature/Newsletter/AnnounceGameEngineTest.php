<?php

declare(strict_types=1);

use App\Mail\GameEngineUpdateMail;
use App\Models\NewsletterSend;
use App\Models\NewsletterSubscriber;
use App\Models\User;
use Illuminate\Support\Facades\Mail;

beforeEach(function () {
    Mail::fake();
    // Писмото води към /game и описва race v2 — иначе командата отказва.
    config(['features.game' => true, 'game.race_version' => 2]);
});

it('праща на потребителите и на бюлетинните абонати', function () {
    $user = User::factory()->create();
    $subscriber = NewsletterSubscriber::create(['email' => 'abonat@example.bg', 'unsubscribe_token' => str_repeat('t', 48)]);

    $this->artisan('padok:announce-game-engine')->assertSuccessful();

    Mail::assertSent(GameEngineUpdateMail::class, 2);
    Mail::assertSent(GameEngineUpdateMail::class, fn ($mail) => $mail->hasTo($user->email));
    Mail::assertSent(GameEngineUpdateMail::class, fn ($mail) => $mail->hasTo($subscriber->email));
});

it('прескача банати и спрели имейлите потребители', function () {
    User::factory()->create(['banned_at' => now()]);
    User::factory()->create(['email_opt_out_at' => now()]);

    $this->artisan('padok:announce-game-engine')->assertSuccessful();

    Mail::assertNothingSent();
});

it('не праща втори път при повторен пуск, а force пуска нарочно', function () {
    User::factory()->create();

    $this->artisan('padok:announce-game-engine')->assertSuccessful();
    $this->artisan('padok:announce-game-engine')->assertSuccessful();

    Mail::assertSent(GameEngineUpdateMail::class, 1);
    expect(NewsletterSend::query()->where('mail_type', 'game-update-2026-09-engine')->count())->toBe(1);

    $this->artisan('padok:announce-game-engine', ['--force' => true])->assertSuccessful();

    Mail::assertSent(GameEngineUpdateMail::class, 2);
});

it('dry-run не праща и не маркира', function () {
    User::factory()->create();

    $this->artisan('padok:announce-game-engine', ['--dry-run' => true])
        ->expectsOutputToContain('1 потребители')
        ->assertSuccessful();

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('отказва да прати при изключена игра', function () {
    User::factory()->create();
    config(['features.game' => false]);

    $this->artisan('padok:announce-game-engine')
        ->expectsOutputToContain('FEATURE_GAME')
        ->assertFailed();

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('отказва да прати преди деплоя на новата версия', function () {
    User::factory()->create();
    config(['game.race_version' => 1]);

    $this->artisan('padok:announce-game-engine')
        ->expectsOutputToContain('deploy.sh')
        ->assertFailed();

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('писмото на потребител описва новостите, има one-click unsubscribe и не кани към регистрация', function () {
    $user = User::factory()->create();

    $this->artisan('padok:announce-game-engine')->assertSuccessful();

    Mail::assertSent(GameEngineUpdateMail::class, function (GameEngineUpdateMail $mail) use ($user) {
        if (! $mail->hasTo($user->email)) {
            return false;
        }

        $html = $mail->render();

        return str_contains($html, 'Нов звук на двигателя')
            && str_contains($html, 'V6 турбо хибрид')
            && str_contains($html, 'Режим за изпреварване вместо DRS')
            && str_contains($html, 'започва наново')
            && str_contains($html, 'заключено')
            && str_contains($html, 'Екипът на Падок')
            && str_contains($html, 'Спри имейлите')
            && ! str_contains($html, 'Регистрирай се и запази времето си')
            && $mail->headers()->text['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click';
    });
});

it('писмото на абонат кани към регистрация и има линк за отписване', function () {
    NewsletterSubscriber::create(['email' => 'abonat@example.bg', 'unsubscribe_token' => str_repeat('t', 48)]);

    $this->artisan('padok:announce-game-engine')->assertSuccessful();

    Mail::assertSent(GameEngineUpdateMail::class, function (GameEngineUpdateMail $mail) {
        $html = $mail->render();

        return str_contains($html, 'Регистрирай се и запази времето си')
            && str_contains($html, 'Отпиши се')
            && str_contains($html, str_repeat('t', 48));
    });
});

it('не споменава марката F1 в темата', function () {
    User::factory()->create();

    $this->artisan('padok:announce-game-engine')->assertSuccessful();

    Mail::assertSent(GameEngineUpdateMail::class, fn (GameEngineUpdateMail $mail) => ! str_contains($mail->envelope()->subject, 'F1'));
});
