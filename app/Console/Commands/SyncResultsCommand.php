<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Race;
use App\Models\Season;
use App\Services\Badges\BadgeService;
use App\Services\Jolpica\ResultSyncService;
use App\Services\Predictions\LeaderboardService;
use App\Services\Telegram\F1ChannelEnqueuer;
use Illuminate\Console\Command;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Log;
use Throwable;

class SyncResultsCommand extends Command
{
    /**
     * Таван на състезанията в едно пускане. Jolpica прави 3 заявки на
     * състезание, тоест 15 при таван 5 — далеч под лимита му.
     */
    private const MAX_RACES_PER_RUN = 5;

    /**
     * Колко назад гледаме за неоценени състезания.
     *
     * Базата пази целия исторически архив (1150+ състезания). Част от старите
     * нямат резултати в източника и никога няма да имат — без този прозорец
     * командата би ги дърпала наново при всяко пускане, вечно.
     */
    private const LOOKBACK_DAYS = 30;

    protected $signature = 'f1:sync-results {race? : ID на състезанието (по подразбиране — всички неоценени + последното)}';

    protected $description = 'Синхрон на резултатите от състезание, точкуване на прогнозите и присъждане на значки.';

    public function handle(ResultSyncService $sync, BadgeService $badges, F1ChannelEnqueuer $enqueuer): int
    {
        $races = $this->resolveRaces();

        if ($races->isEmpty()) {
            $this->warn('Няма състезание за синхрон.');

            return self::SUCCESS;
        }

        $rows = [];
        $failed = false;

        foreach ($races as $race) {
            $this->info("Синхронизирам резултати за: {$race->name} (кръг {$race->round})...");

            try {
                $stats = $sync->sync($race);
            } catch (Throwable $e) {
                // Едно провалено състезание не спира останалите — иначе един
                // проблемен кръг блокира и наваксването на всички след него.
                $this->error("Кръг {$race->round}: синхронът се провали — {$e->getMessage()}");
                // Изходът от крона не се пази никъде — без лога разминат
                // календар (ResultSyncService отказва чужди резултати) би спрял
                // точкуването напълно тихо.
                Log::error("f1:sync-results race {$race->id} (кръг {$race->round}): {$e->getMessage()}");
                $failed = true;

                continue;
            }

            $newBadges = $badges->evaluateForRace($race->fresh());

            $rows[] = [$race->round, $stats['results'], $stats['sprint'], $stats['scored'], $newBadges];
        }

        if ($rows !== []) {
            $this->table(['Кръг', 'Резултати', 'Спринт', 'Точкувани прогнози', 'Нови значки'], $rows);
        }

        $this->awardChampionIfSeasonOver($badges);

        // Синхронът само пълни опашката; изпращането е на channel:post, за да
        // не блокира точкуването при проблем с Telegram.
        $queued = $enqueuer->enqueuePending();

        $this->line("В опашката на канала: {$queued['queued']} нови, {$queued['updated']} обновени");

        foreach ($queued['errors'] as $error) {
            $this->warn($error);
        }

        $this->info('Готово.');

        return $failed ? self::FAILURE : self::SUCCESS;
    }

    /**
     * Кои състезания да синхронизираме.
     *
     * ВСИЧКИ изминали без резултати, най-старото първо, плюс последното
     * изминало. Не само последното: източникът закъснява непредвидимо и ако
     * един кръг изпусне прозореца си, следващият го измества и той остава
     * без резултати ЗАВИНАГИ — а с него и прогнозите за него, неоценени.
     *
     * Последното се пре-синхронизира при всяко пускане нарочно: така
     * промените от стюардите влизат, а safety car, за който OpenF1 още не е
     * бил готов, се доопределя и прогнозите се преточкуват.
     *
     * @return Collection<int, Race>
     */
    private function resolveRaces(): Collection
    {
        $id = $this->argument('race');

        if ($id !== null) {
            return Race::query()->whereKey($id)->get();
        }

        $past = Race::query()
            ->whereNotNull('race_datetime_utc')
            ->where('race_datetime_utc', '<=', now())
            ->where('race_datetime_utc', '>=', now()->subDays(self::LOOKBACK_DAYS));

        $pending = (clone $past)
            ->whereDoesntHave('results')
            ->orderBy('race_datetime_utc')
            ->limit(self::MAX_RACES_PER_RUN)
            ->get();

        $latest = (clone $past)->orderByDesc('race_datetime_utc')->first();

        return $latest === null
            ? $pending
            : $pending->push($latest)->unique('id')->values();
    }

    /**
     * Значката „Шампион на сезона" — присъжда се, щом всички кръгове имат
     * резултати.
     *
     * Методът в BadgeService съществуваше и значката беше в базата, но никой
     * не го викаше: наградата беше недостижима по конструкция. award() е
     * идемпотентен, така че повторните пускания на синхрона не дублират.
     */
    private function awardChampionIfSeasonOver(BadgeService $badges): void
    {
        $season = Season::current();

        if ($season === null) {
            return;
        }

        $withoutResults = $season->races()
            ->whereDoesntHave('results', fn ($q) => $q->where('session_type', 'race'))
            ->exists();

        if ($withoutResults) {
            return; // сезонът още тече
        }

        $leader = app(LeaderboardService::class)->forSeason($season)->first();

        if ($leader === null) {
            return;
        }

        if ($badges->awardSeasonChampion($season, $leader['user']) > 0) {
            $this->info("Значка „Шампион на сезона {$season->year}\" за {$leader['user']->name}.");
        }
    }
}
