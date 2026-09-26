<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Season;
use App\Services\Jolpica\SeasonSyncService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Ежедневният синхрон на календара — само състезанията и сесиите, без пилоти
 * и отбори.
 *
 * Календарът се синхронизираше единствено на ръка (f1:sync-season) и остана
 * от 18.07.2026: Jolpica вмъкна кръг в Малайзия на 04.10, а сайтът не го
 * знаеше. Пилотите и отборите нарочно са извън ежедневния синхрон — пълният
 * f1:sync-season презаписва и ръчните им корекции от админа.
 *
 * Без аргумент синхронизира ТЕКУЩИЯ сезон от базата, не календарната година:
 * през януари Jolpica още няма новия календар, а смяната на сезона остава
 * съзнателна стъпка (f1:sync-season <година>).
 */
class SyncCalendarCommand extends Command
{
    /** След колко дни от последния кръг сезонът се смята за свършил. */
    private const SEASON_OVER_AFTER_DAYS = 7;

    protected $signature = 'f1:sync-calendar {year? : Година на сезона (по подразбиране — текущият сезон)}';

    protected $description = 'Синхрон на календара (състезания и сесии) от Jolpica, съпоставен по писта, а не по номер на кръга.';

    public function handle(SeasonSyncService $service): int
    {
        $season = $this->resolveSeason();

        if ($season === null) {
            $this->warn('Няма текущ сезон — пусни първо f1:sync-season <година>.');

            return self::SUCCESS;
        }

        try {
            $report = $service->syncCalendar($season);
        } catch (Throwable $e) {
            // Грешката отива и в лога: командата върви от крона и само там
            // някой ще я види (MCP recent-logs).
            Log::error("f1:sync-calendar {$season->year}: {$e->getMessage()}");
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        $changes = [
            ...array_map(fn (string $line): string => "нов: {$line}", $report['created']),
            ...array_map(fn (string $line): string => "преномериран: {$line}", $report['renumbered']),
            ...array_map(fn (string $line): string => "махнат: {$line}", $report['removed']),
            ...array_map(fn (string $line): string => "нов час: {$line}", $report['rescheduled']),
            ...array_map(fn (string $line): string => "ръчни часове: {$line}", $report['kept_manual']),
        ];

        foreach ($changes as $line) {
            $this->line($line);
        }

        if ($changes !== []) {
            Log::notice("f1:sync-calendar {$season->year} промени календара", $changes);
        }

        $this->info("Календар {$season->year}: {$report['races']} състезания, промени: ".count($changes).'.');

        if ($this->argument('year') === null) {
            $this->warnIfNextSeasonIsPublished($season, $service);
        }

        return self::SUCCESS;
    }

    /**
     * Смяната на сезона остава ръчна (f1:sync-season <година> презаписва и
     * пилотите, и отборите), но не бива да зависи от нечия памет: щом текущият
     * сезон е свършил и Jolpica вече има следващия, в лога излиза напомняне.
     */
    private function warnIfNextSeasonIsPublished(Season $season, SeasonSyncService $service): void
    {
        $stillRunning = $season->races()
            ->where(fn ($query) => $query
                ->whereNull('race_datetime_utc')
                ->orWhere('race_datetime_utc', '>', now()->subDays(self::SEASON_OVER_AFTER_DAYS)))
            ->exists();

        if ($stillRunning) {
            return;
        }

        $next = $season->year + 1;

        try {
            $published = $service->calendarIsPublished($next);
        } catch (Throwable) {
            return; // само напомняне — Jolpica ще отговори при следващото пускане
        }

        if ($published) {
            $message = "Сезон {$next} е публикуван в Jolpica, а текущият {$season->year} е свършил — пусни f1:sync-season {$next}.";
            Log::warning($message);
            $this->warn($message);
        }
    }

    private function resolveSeason(): ?Season
    {
        $year = $this->argument('year');

        if ($year === null) {
            return Season::current();
        }

        return Season::query()->firstOrCreate(['year' => (int) $year]);
    }
}
