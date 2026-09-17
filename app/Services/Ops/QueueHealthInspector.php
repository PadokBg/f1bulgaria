<?php

declare(strict_types=1);

namespace App\Services\Ops;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Здравето на опашката, прочетено от таблиците jobs и failed_jobs.
 *
 * Единственият надежден белег за спрял worker от приложението: php-fpm не
 * вижда systemd, но вижда готова задача, която никой не взима. Ползва се от
 * дневния отчет (report:daily-activity) и от MCP инструмента queue-health —
 * една логика, две витрини.
 */
class QueueHealthInspector
{
    /**
     * Над толкова минути чакане задачата вече не е пик, а спрял worker.
     *
     * При този размер общност опашката се изпразва за секунди — най-дългата
     * истинска задача (една вълна писма) е под минута. Петнайсет минути дават
     * запас за рестарта при деплой (queue:restart + systemd RestartSec), без да
     * пропуснат мъртъв worker: той се вижда още на първия отчет.
     */
    public const STALE_MINUTES = 15;

    /**
     * Основните числа. Броенето минава през таблиците jobs и failed_jobs —
     * при друг драйвер няма какво да се преброи и `counts_from_database` е
     * false, за да не покаже витрината успокоителни нули.
     *
     * @return array{
     *     driver: string,
     *     counts_from_database: bool,
     *     pending: int,
     *     oldest_minutes: int|null,
     *     failed_in_window: int,
     * }
     */
    public function inspect(CarbonImmutable $failedFrom, CarbonImmutable $failedTo): array
    {
        $connection = (string) config('queue.default');
        $driver = (string) config("queue.connections.{$connection}.driver", $connection);

        if ($driver !== 'database') {
            return [
                'driver' => $driver,
                'counts_from_database' => false,
                'pending' => 0,
                'oldest_minutes' => null,
                'failed_in_window' => 0,
            ];
        }

        $pending = DB::table('jobs')->count();

        // Възрастта се мери от available_at, не от created_at: отложената задача
        // стои в таблицата по проект и не е закъснение, докато часът ѝ не дойде.
        // По created_at всяко отложено писмо би вдигало фалшива аларма.
        $oldestAvailableAt = DB::table('jobs')
            ->where('available_at', '<=', now()->getTimestamp())
            ->min('available_at');

        $oldestMinutes = $oldestAvailableAt === null
            ? null
            : (int) floor((now()->getTimestamp() - (int) $oldestAvailableAt) / 60);

        $failedInWindow = DB::table('failed_jobs')
            ->whereBetween('failed_at', [$failedFrom, $failedTo])
            ->count();

        return [
            'driver' => $driver,
            'counts_from_database' => true,
            'pending' => $pending,
            'oldest_minutes' => $oldestMinutes,
            'failed_in_window' => $failedInWindow,
        ];
    }

    public function isStale(?int $oldestMinutes): bool
    {
        return $oldestMinutes !== null && $oldestMinutes >= self::STALE_MINUTES;
    }

    /**
     * Последните провалени задачи — класът на job-а и първият ред на грешката,
     * колкото да се види „какво и защо“ без queue:failed на сървъра.
     *
     * @return list<array{uuid: string, queue: string, job: string, failed_at: string, error: string}>
     */
    public function recentFailures(int $limit = 5): array
    {
        return DB::table('failed_jobs')
            ->orderByDesc('failed_at')
            ->limit($limit)
            ->get()
            ->map(fn (object $row): array => [
                'uuid' => (string) $row->uuid,
                'queue' => (string) $row->queue,
                'job' => $this->jobName((string) $row->payload),
                'failed_at' => CarbonImmutable::parse((string) $row->failed_at)
                    ->timezone('Europe/Sofia')
                    ->format('Y-m-d H:i'),
                'error' => (string) strtok((string) $row->exception, "\n"),
            ])
            ->all();
    }

    private function jobName(string $payload): string
    {
        $decoded = json_decode($payload, true);

        return is_array($decoded) && is_string($decoded['displayName'] ?? null)
            ? $decoded['displayName']
            : '(неизвестен job)';
    }
}
