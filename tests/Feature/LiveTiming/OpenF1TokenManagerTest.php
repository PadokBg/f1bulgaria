<?php

declare(strict_types=1);

use App\Services\LiveTiming\OpenF1TokenManager;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

beforeEach(function () {
    Cache::flush();
    config(['services.openf1.username' => 'user@example.bg', 'services.openf1.password' => 'secret']);
});

function tokenManager(): OpenF1TokenManager
{
    return app(OpenF1TokenManager::class);
}

it('hasCredentials отразява конфигурацията', function () {
    expect(tokenManager()->hasCredentials())->toBeTrue();

    config(['services.openf1.username' => null]);
    expect(tokenManager()->hasCredentials())->toBeFalse();
});

it('взима токен през password grant и го кешира', function () {
    Http::fake(['*/token' => Http::response(['access_token' => 'abc123', 'expires_in' => 3600])]);

    expect(tokenManager()->getToken())->toBe('abc123')
        ->and(Cache::get('openf1:access-token'))->toBe('abc123');

    // Втори опит ползва кеша (без нова заявка).
    tokenManager()->getToken();
    Http::assertSentCount(1);
});

it('праща form-urlencoded credentials към token endpoint', function () {
    Http::fake(['*/token' => Http::response(['access_token' => 'abc123', 'expires_in' => 3600])]);

    tokenManager()->fetchNewToken();

    Http::assertSent(fn ($request) => $request['username'] === 'user@example.bg'
        && $request['password'] === 'secret'
        && $request['grant_type'] === 'password'
        && str_contains($request->header('Content-Type')[0] ?? '', 'application/x-www-form-urlencoded'));
});

it('връща null без кредитали (не прави заявка)', function () {
    config(['services.openf1.username' => null, 'services.openf1.password' => null]);
    Http::fake();

    expect(tokenManager()->getToken())->toBeNull();
    Http::assertNothingSent();
});

it('връща null при провал на token заявката (graceful)', function () {
    Http::fake(['*/token' => Http::response('denied', 401)]);

    expect(tokenManager()->getToken())->toBeNull();
});

it('след отказани кредитали не пита за токен 15 минути и пише в лога веднъж', function () {
    Log::spy();
    Http::fake(['*/token' => Http::response('denied', 401)]);

    expect(tokenManager()->getToken())->toBeNull()
        ->and(tokenManager()->getToken())->toBeNull()
        ->and(tokenManager()->getToken())->toBeNull();

    // На 02.11.2026 всяка заявка към данните искаше нов токен — по един 401 в секунда.
    Http::assertSentCount(1);
    Log::shouldHaveReceived('warning')->once();

    $this->travel(16)->minutes();

    tokenManager()->getToken();
    Http::assertSentCount(2);
});

it('след временен провал на token сървъра опитва пак след минута', function (int $status) {
    Http::fake(['*/token' => Http::response('unavailable', $status)]);

    tokenManager()->getToken();
    tokenManager()->getToken();
    Http::assertSentCount(1);

    $this->travel(61)->seconds();

    tokenManager()->getToken();
    Http::assertSentCount(2);
})->with([
    'сривнал се сървър' => 503,
    // 429 също е 4xx, но не значи грешни кредитали.
    'лимит' => 429,
]);

it('успешен токен маха паузата', function () {
    Http::fake(['*/token' => Http::sequence()
        ->push('unavailable', 503)
        ->push(['access_token' => 'fresh', 'expires_in' => 3600])]);

    expect(tokenManager()->getToken())->toBeNull();

    $this->travel(61)->seconds();

    expect(tokenManager()->getToken())->toBe('fresh')
        ->and(Cache::has('openf1:access-token-failed'))->toBeFalse();
});

it('връща null при изключение (timeout)', function () {
    Http::fake(fn () => throw new ConnectionException('timeout'));

    expect(tokenManager()->getToken())->toBeNull();
});
