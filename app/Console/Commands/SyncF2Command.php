<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\F2\Api\F2ApiException;
use App\Services\F2\Api\F2ApiSync;
use App\Services\Telegram\F2ChannelEnqueuer;
use Illuminate\Console\Command;

/**
 * Основният F2 синхрон — от официалния резултатен API.
 */
class SyncF2Command extends Command
{
    protected $signature = 'f2:sync
        {--year= : Конкретна година (по подразбиране текущата)}
        {--no-channel : Само синхрон, без поставяне в опашката на канала}';

    protected $description = 'Синхронизира F2 календар, сесии, резултати и класирания от официалния API.';

    public function handle(F2ApiSync $sync, F2ChannelEnqueuer $enqueuer): int
    {
        $year = $this->option('year') !== null ? (int) $this->option('year') : (int) now()->year;

        $this->info("Синхронизирам F2 сезон {$year}…");

        try {
            $stats = $sync->syncSeason($year, function (int $round, string $name, int $sessions): void {
                $this->line(sprintf('  [%d] %s — %d сесии', $round, $name, $sessions));
            });
        } catch (F2ApiException $e) {
            $this->error("Синхронът се провали: {$e->getMessage()}");

            return self::FAILURE;
        }

        $this->table(
            ['Кръгове', 'Сесии', 'Резултати'],
            [[$stats['rounds'], $stats['sessions'], $stats['results']]],
        );

        // Безименен ред от API-то се пропуска, вместо да създаде пилот с празен
        // slug. Ако се появи, искаме да го видим — не бива да е тихо.
        if (($stats['skipped_drivers'] ?? 0) > 0) {
            $this->warn("Пропуснати редове без име и без driverReference: {$stats['skipped_drivers']}");
        }

        foreach ($stats['errors'] as $error) {
            $this->warn($error);
        }

        // Синхронът не праща — само пълни опашката. Изпращането е работа на
        // `channel:post`, за да не блокира синхрона при проблем с Telegram.
        if (! $this->option('no-channel')) {
            $queued = $enqueuer->enqueuePending();

            $this->line("В опашката на канала: {$queued['queued']} нови, {$queued['updated']} обновени");

            foreach ($queued['errors'] as $error) {
                $this->warn($error);
            }
        }

        $this->info('Готово.');

        return self::SUCCESS;
    }
}
