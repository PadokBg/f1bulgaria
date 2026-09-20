<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Console\Commands\Concerns\SendsBulkMail;
use App\Mail\RaceResultMail;
use App\Models\NewsletterSend;
use App\Models\Race;
use App\Models\Season;
use App\Services\Predictions\LeaderboardService;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\URL;

/**
 * Затваря уикенда: писмо до всеки, подал прогноза, с това какво е донесла.
 *
 * Досега кръгът свършваше в тишина. Подсещането преди заключването връщаше
 * хората веднъж, но след състезанието нищо не ги викаше обратно — оттам и
 * картината на прода: 21 души са прогнозирали, 15 от тях точно по веднъж.
 *
 * Изпраща се САМО на подалите прогноза за този кръг. Това не е разпращане, а
 * отговор на собственото им действие — затова и текстът го казва изрично.
 *
 * Зад флаг `features.race_result_mail`: механизмът стои готов, но нищо не
 * тръгва, преди политиката за поверителност да изброи и това писмо.
 */
class RaceResultMailCommand extends Command
{
    use SendsBulkMail;

    protected $signature = 'f1:race-result-mail
        {--race= : ID на състезание (ръчен пуск)}
        {--force : Праща дори ако вече е пращано за този кръг}
        {--dry-run : Само отчита кой би получил писмо}';

    protected $description = 'Праща на прогнозиралите какво им донесе прогнозата за последния точкуван кръг.';

    public function handle(LeaderboardService $leaderboard): int
    {
        if (! config('features.race_result_mail') && ! $this->option('dry-run')) {
            $this->warn('features.race_result_mail е изключен — нищо не се праща. (--dry-run работи и така.)');

            return self::SUCCESS;
        }

        $race = $this->resolveRace();

        if ($race === null) {
            $this->info('Няма точкуван кръг, за който да не е пращано — пропускаме.');

            return self::SUCCESS;
        }

        if (! $this->option('force') && $this->alreadySent($race)) {
            $this->info("Вече е пращано за кръг [{$race->id}] — пропускаме.");

            return self::SUCCESS;
        }

        // Само точкувани прогнози: непоточкувана прогноза няма какво да каже.
        $predictions = $race->predictions()
            ->whereHas('score')
            ->whereHas('user', fn ($query) => $query
                ->whereNull('banned_at')
                ->whereNull('email_opt_out_at'))
            ->with(['score', 'user'])
            ->get();

        if ($predictions->isEmpty()) {
            $this->info("Кръг [{$race->id}] няма точкувани прогнози с получатели — пропускаме.");

            return self::SUCCESS;
        }

        // Мястото В КРЪГА се смята веднъж за всички, не по веднъж на човек.
        $points = $predictions->mapWithKeys(
            fn ($prediction) => [$prediction->id => (int) ($prediction->score?->points ?? 0)]
        );
        $total = $points->count();

        $seasonRanks = $this->seasonRanks($race, $leaderboard);

        if ($this->option('dry-run')) {
            $this->info("[dry-run] {$total} прогнозирали биха получили резултата за „{$race->name_bg}“.");

            return self::SUCCESS;
        }

        foreach ($predictions as $prediction) {
            $mine = $points->get($prediction->id, 0);

            $this->sendMail($prediction->user, new RaceResultMail(
                $race,
                $mine,
                (array) ($prediction->score?->breakdown_json ?? []),
                [
                    'rank' => $points->filter(fn (int $value) => $value > $mine)->count() + 1,
                    'total' => $total,
                ],
                $seasonRanks[$prediction->user_id] ?? null,
                URL::signedRoute('newsletter.user-unsubscribe', ['user' => $prediction->user_id]),
            ));
        }

        $this->markSent($race);

        $this->info("Резултатите са изпратени: {$total} прогнозирали за „{$race->name_bg}“.");

        $this->reportMailOutcome();

        return self::SUCCESS;
    }

    /**
     * Мястото на всеки в класирането за сезона, по user_id.
     *
     * @return array<int, int>
     */
    private function seasonRanks(Race $race, LeaderboardService $leaderboard): array
    {
        $season = $race->season;

        if ($season === null) {
            return [];
        }

        return $leaderboard->forSeason($season)
            ->mapWithKeys(fn (array $row): array => [(int) $row['user']->id => (int) $row['position']])
            ->all();
    }

    /**
     * Кръгът, за който пишем: изрично подаденият, иначе последният ТОЧКУВАН,
     * за който още не е пращано.
     */
    private function resolveRace(): ?Race
    {
        if ($id = $this->option('race')) {
            return Race::query()->find($id);
        }

        $season = Season::current();

        if ($season === null) {
            return null;
        }

        return $season->races()
            ->whereNotNull('race_datetime_utc')
            ->where('race_datetime_utc', '<', now())
            ->whereHas('predictions.score')
            ->orderByDesc('race_datetime_utc')
            ->get()
            ->first(fn (Race $race): bool => ! $this->alreadySent($race));
    }

    private function alreadySent(Race $race): bool
    {
        return NewsletterSend::query()
            ->where('mail_type', NewsletterSend::TYPE_RACE_RESULT)
            ->where('race_id', $race->id)
            ->exists();
    }

    private function markSent(Race $race): void
    {
        NewsletterSend::create([
            'mail_type' => NewsletterSend::TYPE_RACE_RESULT,
            'race_id' => $race->id,
            'sent_at' => Carbon::now(),
        ]);
    }
}
