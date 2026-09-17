<?php

namespace App\Http\Middleware;

use App\Services\Feedback\SurveyPromptService;
use App\Services\LiveTiming\LiveWindowService;
use App\Support\Seo;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Inertia\Middleware;

class HandleInertiaRequests extends Middleware
{
    /**
     * The root template that is loaded on the first page visit.
     *
     * @var string
     */
    protected $rootView = 'app';

    /**
     * Determine the current asset version.
     */
    public function version(Request $request): ?string
    {
        return parent::version($request);
    }

    /**
     * Define the props that are shared by default.
     *
     * @return array<string, mixed>
     */
    public function share(Request $request): array
    {
        return [
            ...parent::share($request),
            'auth' => [
                'user' => $request->user(),
            ],
            'flash' => [
                'success' => fn () => $request->session()->get('success'),
            ],
            'teamBrands' => fn () => config('team-brands'),
            // mcp_ops е сървърен флаг (скрит админ endpoint) — няма какво да
            // прави в навигацията, а издава, че такъв рут съществува.
            'features' => fn () => Arr::except(config('features'), ['mcp_ops']),
            // Тече ли сесия в момента (по разписание, кеш 60 сек) — линкът
            // „На живо" в навигацията се показва само тогава: постоянен
            // „На живо" в менюто в сряда обучава хората, че лъже.
            'liveNow' => fn () => config('features.live_timing')
                && app(LiveWindowService::class)->isLiveNow(),
            // Заглавието се решава сървърно (App\Support\Seo). Подава се и като
            // prop, за да го приложи клиентът при SPA навигация — така таб
            // заглавието и индексираното от Google съвпадат.
            'seoTitle' => fn () => app(Seo::class)->resolvedTitle(),
            // Невидени значки → поздравителен тост (BadgeAwardToast). Празен
            // масив за гост и за всеки без нови — една лека pivot заявка на
            // Inertia отговор, само за влезли.
            'newBadges' => fn () => $request->user()
                ?->badges()
                ->wherePivotNull('seen_at')
                ->get()
                ->map(fn ($badge) => [
                    'slug' => $badge->slug,
                    'name' => $badge->name,
                    'description' => $badge->description,
                ])
                ->values()
                ->all() ?? [],
            'survey' => [
                // Една лека индексирана заявка на реквест; при мащаба на сайта
                // кеширане би било свръхинженерство.
                'shouldPrompt' => fn () => app(SurveyPromptService::class)->shouldPrompt($request->user()),
            ],
        ];
    }
}
