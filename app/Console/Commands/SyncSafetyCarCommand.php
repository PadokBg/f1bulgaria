<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Race;
use App\Models\Season;
use App\Services\Badges\BadgeService;
use App\Services\LiveTiming\SafetyCarDetector;
use App\Services\Predictions\PredictionScoringService;
use Illuminate\Console\Command;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Log;

/**
 * Safety car от OpenF1 за вече изминали кръгове + преточкуване.
 *
 * Обичайно safety car се попълва от f1:sync-results в момента на
 * резултатите. Тази команда е мрежата отдолу: кръг, за който OpenF1 не е бил
 * готов, докато е бил последен, и еднократното наваксване на сезон 2026, в
 * който полето не беше попълнено нито веднъж.
 */
class SyncSafetyCarCommand extends Command
{
    /** След колко часа от старта липсващият отговор става повод за предупреждение. */
    private const OVERDUE_AFTER_HOURS = 12;

    protected $signature = 'f1:sync-safety-car
        {race? : ID на състезанието (по подразбиране — всички кръгове с прогнози и неизвестен safety car)}
        {--season= : Година на сезона (по подразбиране — текущият)}
        {--dry-run : Само покажи какво е намерено, без да записваш}
        {--force : Провери наново и вече попълнените, включително ръчно въведените}';

    protected $description = 'Попълва safety car от OpenF1 за изминали кръгове и преточкува прогнозите.';

    public function handle(SafetyCarDetector $detector, PredictionScoringService $scoring, BadgeService $badges): int
    {
        $races = $this->resolveRaces();

        if ($races->isEmpty()) {
            $this->info('Няма кръгове за проверка.');

            return self::SUCCESS;
        }

        $dryRun = (bool) $this->option('dry-run');
        $force = (bool) $this->option('force');
        $rows = [];

        foreach ($races as $race) {
            $seen = $detector->inspect($race);
            $detected = $detector->decide($seen);
            $changed = $detected !== null && $detected !== $race->had_safety_car;
            // Попълнената стойност може да е ръчна корекция от Filament —
            // презаписва се само с --force, и при изрично посочен кръг.
            $locked = $race->had_safety_car !== null && ! $force;
            $scored = 0;

            if ($changed && ! $locked && ! $dryRun) {
                $race->update(['had_safety_car' => $detected]);
                $scored = $scoring->scoreRace($race->fresh());
                $badges->evaluateForRace($race->fresh());
            }

            if ($detected === null && $this->isOverdue($race)) {
                Log::warning("Safety car за кръг {$race->round} ({$race->name_bg}) не се определи от OpenF1 — попълни го ръчно във Filament.");
            }

            $rows[] = [
                $race->round,
                $race->name_bg,
                $this->describe($seen),
                $this->answer($locked ? $race->had_safety_car : ($detected ?? $race->had_safety_car)),
                $race->predictions()->count(),
                match (true) {
                    $changed && $locked => 'ръчно — само с --force',
                    $dryRun => $changed ? 'ще се преточкува' : '—',
                    default => $scored > 0 ? $scored : '—',
                },
            ];
        }

        $this->table(['Кръг', 'Състезание', 'OpenF1', 'Safety car', 'Прогнози', 'Преточкувани'], $rows);

        if ($dryRun) {
            $this->warn('Пробно пускане — нищо не е записано.');
        }

        return self::SUCCESS;
    }

    /**
     * @return Collection<int, Race>
     */
    private function resolveRaces(): Collection
    {
        $id = $this->argument('race');

        if ($id !== null) {
            return Race::query()->whereKey($id)->with('season')->get();
        }

        $year = $this->option('season');
        $season = $year !== null
            ? Season::query()->where('year', (int) $year)->first()
            : Season::current();

        if ($season === null) {
            return collect();
        }

        return $season->races()
            ->with('season')
            ->whereHas('results', fn ($query) => $query->where('session_type', 'race'))
            ->whereHas('predictions')
            ->when(! $this->option('force'), fn ($query) => $query->whereNull('had_safety_car'))
            ->orderBy('round')
            ->get();
    }

    /**
     * OpenF1 има данните половин час след финала. Ако и след половин ден
     * отговор няма (напр. в дирекцията липсва карираният флаг), той няма да
     * дойде сам — нужен е човек, а без лога никой нямаше да разбере.
     */
    private function isOverdue(Race $race): bool
    {
        return $race->race_datetime_utc !== null
            && $race->race_datetime_utc->lt(now()->subHours(self::OVERDUE_AFTER_HOURS));
    }

    /**
     * @param  array{safety_car: bool, virtual_safety_car: bool}|null  $seen
     */
    private function describe(?array $seen): string
    {
        return match (true) {
            $seen === null => 'няма окончателни данни',
            $seen['safety_car'] && $seen['virtual_safety_car'] => 'SC + VSC',
            $seen['safety_car'] => 'SC',
            $seen['virtual_safety_car'] => 'само VSC',
            default => 'нито SC, нито VSC',
        };
    }

    private function answer(?bool $value): string
    {
        return match ($value) {
            true => 'да',
            false => 'не',
            null => '?',
        };
    }
}
