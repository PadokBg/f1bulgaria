<?php

declare(strict_types=1);

use App\Mail\GameNewsMail;
use App\Models\NewsletterSend;
use App\Models\NewsletterSubscriber;
use App\Models\User;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Schema;

beforeEach(function () {
    Mail::fake();
    // Писмото води към /game — при изключен флаг командата отказва.
    config(['features.game' => true]);
});

it('праща на потребителите и на бюлетинните абонати', function () {
    $user = User::factory()->create();
    $subscriber = NewsletterSubscriber::create(['email' => 'abonat@example.bg', 'unsubscribe_token' => str_repeat('t', 48)]);

    $this->artisan('padok:announce-game-news')->assertSuccessful();

    Mail::assertSent(GameNewsMail::class, 2);
    Mail::assertSent(GameNewsMail::class, fn ($mail) => $mail->hasTo($user->email));
    Mail::assertSent(GameNewsMail::class, fn ($mail) => $mail->hasTo($subscriber->email));
});

it('прескача банати и спрели имейлите потребители', function () {
    User::factory()->create(['banned_at' => now()]);
    User::factory()->create(['email_opt_out_at' => now()]);

    $this->artisan('padok:announce-game-news')->assertSuccessful();

    Mail::assertNothingSent();
});

it('не праща втори път при повторен пуск, а force пуска нарочно', function () {
    User::factory()->create();

    $this->artisan('padok:announce-game-news')->assertSuccessful();
    $this->artisan('padok:announce-game-news')->assertSuccessful();

    Mail::assertSent(GameNewsMail::class, 1);
    expect(NewsletterSend::query()->where('mail_type', 'game-news-2026-09-race')->count())->toBe(1);

    $this->artisan('padok:announce-game-news', ['--force' => true])->assertSuccessful();

    Mail::assertSent(GameNewsMail::class, 2);
});

it('dry-run не праща и не маркира', function () {
    User::factory()->create();

    $this->artisan('padok:announce-game-news', ['--dry-run' => true])
        ->expectsOutputToContain('1 потребители')
        ->assertSuccessful();

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('отказва да прати при изключена игра', function () {
    User::factory()->create();
    config(['features.game' => false]);

    $this->artisan('padok:announce-game-news')
        ->expectsOutputToContain('FEATURE_GAME')
        ->assertFailed();

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('отказва да прати преди деплоя на новата версия', function () {
    User::factory()->create();
    Schema::drop('game_race_records');

    $this->artisan('padok:announce-game-news')
        ->expectsOutputToContain('deploy.sh')
        ->assertFailed();

    Mail::assertNothingSent();
    expect(NewsletterSend::query()->count())->toBe(0);
});

it('писмото на потребител описва новостите, има one-click unsubscribe и не кани към регистрация', function () {
    $user = User::factory()->create();

    $this->artisan('padok:announce-game-news')->assertSuccessful();

    Mail::assertSent(GameNewsMail::class, function (GameNewsMail $mail) use ($user) {
        if (! $mail->hasTo($user->email)) {
            return false;
        }

        $html = $mail->render();

        return str_contains($html, 'По-умни ботове')
            && str_contains($html, 'DRS')
            && str_contains($html, 'Наказание при вина за удар')
            && str_contains($html, 'Радар за кола отстрани')
            && str_contains($html, 'Сам на пистата')
            && str_contains($html, 'започва от нулата')
            && str_contains($html, 'Екипът на Падок')
            && str_contains($html, 'Спри имейлите')
            && ! str_contains($html, 'Регистрирай се и запази времето си')
            && $mail->headers()->text['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click';
    });
});

it('писмото на абонат кани към регистрация и има линк за отписване', function () {
    NewsletterSubscriber::create(['email' => 'abonat@example.bg', 'unsubscribe_token' => str_repeat('t', 48)]);

    $this->artisan('padok:announce-game-news')->assertSuccessful();

    Mail::assertSent(GameNewsMail::class, function (GameNewsMail $mail) {
        $html = $mail->render();

        return str_contains($html, 'Регистрирай се и запази времето си')
            && str_contains($html, 'Отпиши се')
            && str_contains($html, str_repeat('t', 48));
    });
});
