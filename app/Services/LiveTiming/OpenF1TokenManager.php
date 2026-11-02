<?php

declare(strict_types=1);

namespace App\Services\LiveTiming;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Управлява OAuth2 (password grant) достъпа до OpenF1. Взима access token през
 * POST /token (form-urlencoded user+pass), кешира го за ~90% от expires_in и
 * го презарежда при изтичане. Защитно: при липса на кредитал или грешка → null.
 */
class OpenF1TokenManager
{
    private const CACHE_KEY = 'openf1:access-token';

    /**
     * Маркер за пауза след неуспешна token заявка.
     *
     * Без него всяка заявка към данните първо искаше нов токен. На 02.11.2026
     * отказаните кредитали (401) дадоха по едно предупреждение в секунда и
     * двойно повече заявки, а лимитът свърши с 429.
     */
    private const FAILURE_KEY = 'openf1:access-token-failed';

    /** Отказани кредитали (400/401/403) няма да се оправят от само себе си. */
    private const REJECTED_BACKOFF_SECONDS = 900;

    /** Сривнал се token сървър или мрежа може да се оправи веднага. */
    private const ERROR_BACKOFF_SECONDS = 60;

    public function hasCredentials(): bool
    {
        return filled(config('services.openf1.username')) && filled(config('services.openf1.password'));
    }

    /**
     * Валиден токен (от кеша или нов). null ако няма кредитали/при грешка.
     */
    public function getToken(): ?string
    {
        if (! $this->hasCredentials()) {
            return null;
        }

        $cached = Cache::get(self::CACHE_KEY);

        if (is_string($cached) && $cached !== '') {
            return $cached;
        }

        // В пауза след провал: заявките минават без токен, както и при провала.
        if (Cache::has(self::FAILURE_KEY)) {
            return null;
        }

        return $this->fetchNewToken();
    }

    /**
     * Заявява нов токен и го кешира. null при провал.
     */
    public function fetchNewToken(): ?string
    {
        if (! $this->hasCredentials()) {
            return null;
        }

        try {
            $response = Http::asForm()
                ->timeout((int) config('services.openf1.timeout', 10))
                ->post((string) config('services.openf1.token_url'), [
                    'grant_type' => 'password',
                    'username' => (string) config('services.openf1.username'),
                    'password' => (string) config('services.openf1.password'),
                ]);

            if (! $response->successful()) {
                // 429 също е 4xx, но е временен — само отказаните кредитали чакат дълго.
                $rejected = in_array($response->status(), [400, 401, 403], strict: true);
                $backoff = $rejected ? self::REJECTED_BACKOFF_SECONDS : self::ERROR_BACKOFF_SECONDS;
                $this->pause($backoff);

                Log::warning('OpenF1 token заявка неуспешна', array_filter([
                    'status' => $response->status(),
                    'retry_in_seconds' => $backoff,
                    'hint' => $rejected ? 'провери OPENF1_USERNAME/OPENF1_PASSWORD и абонамента' : null,
                ]));

                return null;
            }

            $token = $response->json('access_token');
            $expiresIn = (int) ($response->json('expires_in') ?? 3600);

            if (! is_string($token) || $token === '') {
                return null;
            }

            // Кешираме за ~90% от живота на токена (буфер срещу изтичане).
            $ttl = max(60, (int) floor($expiresIn * 0.9));
            Cache::put(self::CACHE_KEY, $token, now()->addSeconds($ttl));
            Cache::forget(self::FAILURE_KEY);

            return $token;
        } catch (Throwable $e) {
            $this->pause(self::ERROR_BACKOFF_SECONDS);
            Log::warning('OpenF1 token заявка хвърли изключение', ['error' => $e->getMessage()]);

            return null;
        }
    }

    private function pause(int $seconds): void
    {
        Cache::put(self::FAILURE_KEY, true, now()->addSeconds($seconds));
    }

    /**
     * Изчиства кеширания токен (напр. след 401 → форсиране на нов).
     */
    public function forget(): void
    {
        Cache::forget(self::CACHE_KEY);
    }
}
