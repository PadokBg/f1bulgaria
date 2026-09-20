<?php

declare(strict_types=1);

namespace App\Services\Tsolov;

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2RaceSession;
use App\Models\F2Season;
use App\Support\DriverName;
use Illuminate\Support\Facades\Cache;

/**
 * „Цоловметър" — къде е Никола Цолов в шампионата на Ф2 и кога кара пак.
 *
 * Отделна услуга, защото същите числа трябват на две места: блока на
 * началната страница и писмото с новостите. Писмо със застояли числа е
 * по-лошо от писмо без числа — затова се смятат при пращането, не се пишат
 * на ръка в шаблона.
 */
class TsolovMeter
{
    /** Slug на Цолов в `f2_drivers`. */
    private const SLUG = 'nikola-tsolov';

    /**
     * Кешът е 10 минути: началната е най-натоварената страница, а класирането
     * се мени по веднъж на кръг.
     */
    private const CACHE_MINUTES = 10;

    /**
     * null = няма какво да се покаже: изключен флаг, несинхронизиран сезон или
     * пилот без позиция в класирането.
     *
     * @return array<string, mixed>|null
     */
    public function summary(): ?array
    {
        if (! config('features.tsolov')) {
            return null;
        }

        return Cache::remember('tsolov:meter', now()->addMinutes(self::CACHE_MINUTES), fn (): ?array => $this->build());
    }

    /**
     * @return array<string, mixed>|null
     */
    private function build(): ?array
    {
        $season = F2Season::query()->where('is_current', true)->first();

        if ($season === null) {
            return null;
        }

        $tsolov = F2Driver::query()
            ->where('f2_season_id', $season->id)
            ->where('slug', self::SLUG)
            ->first();

        if ($tsolov === null || $tsolov->position === null) {
            return null;
        }

        $leads = $tsolov->position === 1;

        // Съперникът: вторият, ако Цолов води; иначе този точно пред него.
        // orderByDesc('points') е защита срещу два реда на една позиция —
        // синхронизацията вече е създавала дубликат на един пилот
        // (виж f2:merge-duplicate-drivers).
        $rival = F2Driver::query()
            ->where('f2_season_id', $season->id)
            ->where('position', $leads ? 2 : $tsolov->position - 1)
            ->orderByDesc('points')
            ->first();

        return [
            'position' => $tsolov->position,
            'points' => (float) $tsolov->points,
            'leads' => $leads,
            'rival' => $rival === null ? null : [
                'name' => DriverName::display($rival->slug, $rival->fullName()),
                'gap' => round(abs((float) $tsolov->points - (float) $rival->points), 1),
            ],
            'rounds_left' => $this->roundsLeft($season),
            'next' => $this->nextSession($season),
        ];
    }

    /** Колко кръга остават до края на сезона във Ф2. */
    private function roundsLeft(F2Season $season): int
    {
        return $season->races()
            ->whereHas('sessions', fn ($query) => $query
                ->where('session_type', F2SessionType::FeatureRace)
                ->where('scheduled_at_utc', '>', now()))
            ->count();
    }

    /**
     * Следващата сесия с точки (спринт или главно).
     *
     * Тренировките и квалификациите нарочно се пропускат: бройката до тях не
     * казва нищо на човек, който иска да знае кога Цолов се бори за точки.
     *
     * @return array<string, mixed>|null
     */
    private function nextSession(F2Season $season): ?array
    {
        $session = F2RaceSession::query()
            ->whereIn('session_type', [F2SessionType::SprintRace, F2SessionType::FeatureRace])
            ->whereHas('race', fn ($query) => $query->where('f2_season_id', $season->id))
            ->where('scheduled_at_utc', '>', now())
            ->orderBy('scheduled_at_utc')
            ->with('race:id,location_name,country_name,round')
            ->first();

        if ($session === null) {
            return null;
        }

        return [
            'label' => $session->session_type->label(),
            'location' => $session->race?->location_name,
            'round' => $session->race?->round,
            // TBC час се показва само като ден — иначе броячът лъже до минутата.
            'at' => $session->scheduled_at_utc?->toIso8601String(),
            'time_tbc' => (bool) $session->time_tbc,
        ];
    }
}
