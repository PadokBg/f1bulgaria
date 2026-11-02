<?php

declare(strict_types=1);

namespace App\Services\Jolpica;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Тънък клиент за Jolpica (Ergast-съвместим) F1 API.
 *
 * Връща винаги съдържанието на `MRData` като асоциативен масив и се грижи за
 * pagination-а (limit/offset) на endpoint-ите, които го изискват.
 *
 * Retry политика: 4xx = наша грешка (не повтаряме); 5xx и мрежови грешки =
 * техен проблем → повтаряме с exponential backoff; 429 = по-дълга пауза.
 *
 * @see https://api.jolpi.ca/ergast/f1/
 */
class JolpicaClient
{
    private const PAGE_SIZE = 100;

    private function request(): PendingRequest
    {
        /** @var array{base_url:string,timeout:int} $config */
        $config = config('services.jolpica');

        return Http::baseUrl($config['base_url'])
            ->acceptJson()
            ->timeout($config['timeout']);
    }

    /**
     * Изпълнява GET и връща `MRData` масива, с retry при 5xx/429/мрежа.
     *
     * @return array<string, mixed>
     *
     * @throws JolpicaException
     */
    public function get(string $path, int $offset = 0): array
    {
        $url = ltrim($path, '/').'.json';
        $query = ['limit' => self::PAGE_SIZE, 'offset' => $offset];

        $maxAttempts = max(1, (int) config('services.jolpica.retry_times', 3));
        $baseSleepMs = (int) config('services.jolpica.retry_sleep_ms', 500);

        $lastStatus = null;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                $response = $this->request()->get($url, $query);
            } catch (ConnectionException $e) {
                // Мрежова грешка (timeout, connection refused) — третира се като 5xx.
                $lastStatus = 'network';
                $this->backoff($attempt, $maxAttempts, $baseSleepMs, $url, 'мрежова грешка', false);

                continue;
            }

            if ($response->successful()) {
                /** @var array<string, mixed> $data */
                $data = $response->json('MRData', []);

                return $data;
            }

            $lastStatus = $response->status();

            // 4xx (без 429) = наша грешка — няма смисъл да повтаряме.
            if ($response->clientError() && $response->status() !== 429) {
                throw new JolpicaException("Jolpica върна {$response->status()} за {$url} — заявката е невалидна.");
            }

            // 5xx или 429 — техен проблем, повтаряме.
            $this->backoff($attempt, $maxAttempts, $baseSleepMs, $url, (string) $response->status(), $response->status() === 429);
        }

        if ($lastStatus === 429) {
            throw new JolpicaRateLimitException(
                "Jolpica rate limit: {$maxAttempts} опита за {$url} удариха 429. Изчакай часовия прозорец и опитай пак.",
            );
        }

        throw new JolpicaException(
            "Jolpica API недостъпен след {$maxAttempts} опита за {$url} (последен статус: {$lastStatus}). Опитай по-късно.",
        );
    }

    /**
     * Изчаква с exponential backoff преди следващия опит (логва причината).
     * 429 (rate limit) изчаква по-дълго.
     */
    private function backoff(int $attempt, int $maxAttempts, int $baseSleepMs, string $url, string $reason, bool $rateLimited): void
    {
        if ($attempt >= $maxAttempts) {
            return;
        }

        // При rate limit (429) изчакваме по-дълго — 4x базата.
        $base = $rateLimited ? $baseSleepMs * 4 : $baseSleepMs;
        $delayMs = $base * (2 ** ($attempt - 1));

        Log::warning(sprintf(
            'Jolpica returned %s for %s, retrying in %.1fs (опит %d/%d)',
            $reason, $url, $delayMs / 1000, $attempt, $maxAttempts,
        ));

        if ($delayMs > 0) {
            usleep($delayMs * 1000);
        }
    }

    /**
     * Изпълнява GET и събира всички страници от подадения списък.
     *
     * @param  string  $tableKey  ключът на таблицата в MRData (напр. "RaceTable")
     * @param  string  $listKey  ключът на списъка в таблицата (напр. "Races")
     * @return array<int, array<string, mixed>>
     */
    public function getAll(string $path, string $tableKey, string $listKey): array
    {
        $offset = 0;
        $items = [];

        do {
            $data = $this->get($path, $offset);
            $table = $data[$tableKey] ?? [];
            $page = $table[$listKey] ?? [];
            $items = array_merge($items, $page);

            $total = (int) ($data['total'] ?? 0);
            $offset += self::PAGE_SIZE;
        } while ($offset < $total);

        return $items;
    }

    /**
     * Календар (състезания) за сезон.
     *
     * @return array<int, array<string, mixed>>
     */
    public function races(int $year): array
    {
        return $this->getAll((string) $year, 'RaceTable', 'Races');
    }

    /**
     * Пилоти за сезон.
     *
     * @return array<int, array<string, mixed>>
     */
    public function drivers(int $year): array
    {
        return $this->getAll("{$year}/drivers", 'DriverTable', 'Drivers');
    }

    /**
     * Конструктори за сезон.
     *
     * @return array<int, array<string, mixed>>
     */
    public function constructors(int $year): array
    {
        return $this->getAll("{$year}/constructors", 'ConstructorTable', 'Constructors');
    }

    /**
     * Класиране на пилотите (съдържа текущия конструктор на всеки пилот).
     *
     * @return array<int, array<string, mixed>>
     */
    public function driverStandings(int $year): array
    {
        $data = $this->get("{$year}/driverstandings");
        $lists = $data['StandingsTable']['StandingsLists'] ?? [];

        return $lists[0]['DriverStandings'] ?? [];
    }

    /**
     * Един кръг от даден endpoint (results, sprint, qualifying) — самото
     * състезание заедно с класацията. null, ако кръгът още няма данни.
     *
     * Връща цялото състезание, а не само класацията, заради пистата в него:
     * с нея се проверява, че нашият номер на кръга и този в Jolpica сочат едно
     * и също състезание (виж ResultSyncService).
     *
     * @return array<string, mixed>|null
     */
    public function raceData(int $year, int $round, string $endpoint): ?array
    {
        $data = $this->get("{$year}/{$round}/{$endpoint}");

        return $data['RaceTable']['Races'][0] ?? null;
    }

    /**
     * Резултати от едно състезание.
     *
     * @return array<int, array<string, mixed>>
     */
    public function results(int $year, int $round): array
    {
        return $this->raceData($year, $round, 'results')['Results'] ?? [];
    }

    /**
     * Резултати от спринта (само за спринт уикенди). Носят отделни точки.
     *
     * @return array<int, array<string, mixed>>
     */
    public function sprintResults(int $year, int $round): array
    {
        return $this->raceData($year, $round, 'sprint')['SprintResults'] ?? [];
    }

    /**
     * Класиране от квалификацията (за определяне на pole).
     *
     * @return array<int, array<string, mixed>>
     */
    public function qualifying(int $year, int $round): array
    {
        return $this->raceData($year, $round, 'qualifying')['QualifyingResults'] ?? [];
    }
}
