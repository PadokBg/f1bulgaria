<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Enums\ResultSessionType;
use App\Mcp\Concerns\FormatsSofiaTime;
use App\Models\AuthEvent;
use App\Models\NewsletterSubscriber;
use App\Models\Prediction;
use App\Models\Race;
use App\Models\Season;
use App\Models\TeamNewsItem;
use App\Models\User;
use App\Services\Predictions\PredictionLockService;
use Carbon\CarbonImmutable;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Едно извикване = снимка на сайта: потребители, прогнози, сезон, следващ
 * кръг, бюлетин, новини. Първият инструмент, който AI клиентът трябва да
 * пусне, преди да рови с sql-query.
 */
#[Name('site-overview')]
#[Description('Обща снимка на Падок: брой потребители (общо, нови за 7/30 дни, активни), прогнози, текущ сезон, следващо състезание и срок за прогнози, бюлетин и новини. Започни оттук.')]
#[IsReadOnly]
#[IsIdempotent]
class SiteOverviewTool extends Tool
{
    use FormatsSofiaTime;

    public function handle(Request $request, PredictionLockService $locks): ResponseFactory
    {
        $now = CarbonImmutable::now();
        $season = Season::current();

        return Response::structured([
            'generated_at' => $this->sofia($now),
            'users' => $this->users($now),
            'predictions' => [
                'total' => Prediction::query()->count(),
                'current_season' => $season === null
                    ? 0
                    : Prediction::query()->whereHas('race', fn ($q) => $q->where('season_id', $season->id))->count(),
                'distinct_predictors' => Prediction::query()->distinct('user_id')->count('user_id'),
            ],
            'season' => $season === null ? null : [
                'year' => $season->year,
                'races' => $season->races()->count(),
                'races_with_results' => $season->races()
                    ->whereHas('results', fn ($q) => $q->where('session_type', ResultSessionType::Race->value))
                    ->count(),
            ],
            'next_race' => $this->nextRace($now, $locks),
            'newsletter' => [
                'active_subscribers' => NewsletterSubscriber::query()->active()->count(),
                'users_opted_out' => User::query()->whereNotNull('email_opt_out_at')->count(),
            ],
            'news' => [
                'published_items' => TeamNewsItem::query()->published()->count(),
                'published_last_7_days' => TeamNewsItem::query()->published()
                    ->where('published_at', '>=', $now->subDays(7))
                    ->count(),
            ],
        ]);
    }

    /**
     * @return array<string, int>
     */
    private function users(CarbonImmutable $now): array
    {
        return [
            'total' => User::query()->count(),
            'admins' => User::query()->where('is_admin', true)->count(),
            'banned' => User::query()->whereNotNull('banned_at')->count(),
            'registered_last_7_days' => User::query()->where('created_at', '>=', $now->subDays(7))->count(),
            'registered_last_30_days' => User::query()->where('created_at', '>=', $now->subDays(30))->count(),
            'logged_in_last_7_days' => AuthEvent::query()
                ->where('type', AuthEvent::TYPE_LOGIN)
                ->where('created_at', '>=', $now->subDays(7))
                ->whereNotNull('user_id')
                ->distinct('user_id')
                ->count('user_id'),
        ];
    }

    /**
     * Следващият кръг по време на състезанието + състоянието на прогнозите
     * за него. Срокът идва от PredictionLockService — същото правило, по
     * което f1:lock-predictions заключва.
     *
     * @return array<string, mixed>|null
     */
    private function nextRace(CarbonImmutable $now, PredictionLockService $locks): ?array
    {
        $race = Race::query()
            ->whereNotNull('race_datetime_utc')
            ->where('race_datetime_utc', '>', $now)
            ->orderBy('race_datetime_utc')
            ->first();

        if ($race === null) {
            return null;
        }

        $deadline = $locks->lockDeadline($race);

        return [
            'id' => $race->id,
            'round' => $race->round,
            'name' => $race->name_bg,
            'race_at' => $this->sofia($race->race_datetime_utc),
            'qualifying_at' => $this->sofia($race->qualifying_datetime_utc),
            'predictions_lock_at' => $this->sofia($deadline),
            'predictions_open' => $deadline === null || $deadline->isFuture(),
            'predictions_count' => $race->predictions()->count(),
        ];
    }
}
