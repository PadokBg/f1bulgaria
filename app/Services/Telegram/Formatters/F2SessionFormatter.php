<?php

declare(strict_types=1);

namespace App\Services\Telegram\Formatters;

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Services\Telegram\TelegramText;
use App\Support\DriverName;
use Illuminate\Support\Collection;

/**
 * Съставя поста за F2 сесия.
 *
 * Публикуваме първите десет плюс линк към сайта, а не цялата класация: двайсет
 * и два реда правят поста нечетим на телефон и приближават лимита от 4096
 * знака, а линкът връща трафик към padok.bg.
 *
 * Имената минават през DriverName — сайтът е само на български и „Nikola
 * Tsolov" в канал за българска аудитория изглежда като чужд продукт.
 */
class F2SessionFormatter
{
    private const VISIBLE_POSITIONS = 10;

    private const MEDALS = [1 => '🥇', 2 => '🥈', 3 => '🥉'];

    /** Кратки български дни за реда „Следва". */
    private const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

    public function format(F2RaceSession $session): string
    {
        $session->loadMissing(['race.season', 'results.driver.team']);

        $type = $session->session_type;
        $classified = $this->classified($session);

        $lines = [
            '🏁 <b>Формула 2 · '.TelegramText::escape($type->label()).'</b>',
            TelegramText::escape($this->subtitle($session)),
            '',
        ];

        foreach ($classified->take(self::VISIBLE_POSITIONS) as $result) {
            $lines[] = $this->resultLine($result, $type);
        }

        $highlight = $this->highlightLine($session, $classified);

        if ($highlight !== null) {
            $lines[] = '';
            $lines[] = $highlight;
        }

        $retired = $this->retired($session);

        if ($retired->isNotEmpty()) {
            $lines[] = '';
            $lines[] = '<i>Отпаднали: '.TelegramText::escape($retired->implode(', ')).'</i>';
        }

        $lines = [...$lines, ...$this->context($session, $type)];

        if ($session->version === 'Provisional') {
            $lines[] = '';
            $lines[] = '<i>⚠️ Временна класация — стюардите още не са се произнесли. Постът ще се обнови.</i>';
        }

        $url = $this->url($session);

        if ($url !== null) {
            $lines[] = '';
            $lines[] = '<a href="'.TelegramText::escape($url).'">Пълна класация в Падок</a>';
        }

        return implode("\n", $lines);
    }

    /**
     * „Гран при на Унгария · кръг 9".
     *
     * Българското име идва от config/race-names-bg.php през връзката към F1
     * пистата. Без нея пада към името на локацията, което е на латиница.
     */
    private function subtitle(F2RaceSession $session): string
    {
        $race = $session->race;

        if ($race === null) {
            return '';
        }

        $name = config('race-names-bg')[$race->circuit_jolpica_id] ?? null;

        return collect([
            is_string($name) ? $name : ($race->location_name ?: $race->country_name),
            $race->round !== null ? "кръг {$race->round}" : null,
        ])->filter()->implode(' · ');
    }

    /**
     * Допълнителните редове под класацията, в реда на четене.
     *
     * @return array<int, string>
     */
    private function context(F2RaceSession $session, F2SessionType $type): array
    {
        $lines = [];

        // Пол позицията има смисъл само за главното състезание — решетката на
        // спринта е обърнатата десетка, не резултат от квалификация.
        if (in_array($type, [F2SessionType::FeatureRace, F2SessionType::SecondFeatureRace], strict: true) && $session->poleDriver !== null) {
            $lines[] = '';
            $lines[] = '🅿️ От пол позиция: <b>'.TelegramText::escape($this->name($session->poleDriver)).'</b>';
        }

        if (in_array($type, [F2SessionType::FeatureRace, F2SessionType::SecondFeatureRace], strict: true)) {
            $standings = $this->standings($session);

            if ($standings !== null) {
                $lines[] = '';
                $lines[] = '📊 Шампионат: '.$standings;
            }
        }

        $next = $this->nextSession($session);

        if ($next !== null) {
            $lines[] = '';
            $lines[] = '⏱ Следва: '.$next;
        }

        return $lines;
    }

    /**
     * Първите трима в шампионата след кръга.
     */
    private function standings(F2RaceSession $session): ?string
    {
        $seasonId = $session->race?->f2_season_id;

        if ($seasonId === null) {
            return null;
        }

        $top = F2Driver::query()
            ->where('f2_season_id', $seasonId)
            ->whereNotNull('position')
            ->orderBy('position')
            ->limit(3)
            ->get();

        if ($top->isEmpty()) {
            return null;
        }

        return $top
            ->map(fn (F2Driver $driver): string => TelegramText::escape(
                $this->surname($driver).' '.$this->points((float) $driver->points),
            ))
            ->implode(' · ');
    }

    /**
     * „Спринт — Сб, 15:15" в софийско време.
     */
    private function nextSession(F2RaceSession $session): ?string
    {
        $seasonId = $session->race?->f2_season_id;

        if ($seasonId === null) {
            return null;
        }

        // Вземаме няколко и подреждаме в PHP: при неизвестен час всички сесии
        // от кръга носят едно и също време и SQL подредбата ги разбърква —
        // така постът обявяваше квалификацията преди тренировката.
        $next = F2RaceSession::query()
            ->whereHas('race', fn ($query) => $query->where('f2_season_id', $seasonId))
            ->whereNotNull('scheduled_at_utc')
            ->where('scheduled_at_utc', '>', now())
            ->orderBy('scheduled_at_utc')
            ->with('race')
            ->limit(8)
            ->get()
            ->sortBy(fn (F2RaceSession $s): array => [
                $s->scheduled_at_utc->getTimestamp(),
                $s->session_type->order(),
            ])
            ->first();

        if ($next === null) {
            return null;
        }

        $sofia = $next->scheduled_at_utc->copy()->setTimezone('Europe/Sofia');
        $sameWeekend = $next->f2_race_id === $session->f2_race_id;

        // Часът се показва само ако наистина е обявен. Иначе API-то дава 00:00
        // местно време, което в софийско става 01:00 — час, в който F2 не кара.
        $when = match (true) {
            $next->time_tbc && $sameWeekend => 'предстои',
            $next->time_tbc => $sofia->format('d.m'),
            $sameWeekend => self::WEEKDAYS[(int) $sofia->dayOfWeek].', '.$sofia->format('H:i'),
            default => $sofia->format('d.m').', '.$sofia->format('H:i'),
        };

        // Сесия от друг кръг без уточнение е подвеждаща — човек я чака този уикенд.
        $label = $next->session_type->label();

        if (! $sameWeekend) {
            $label .= ', кръг '.$next->race?->round;
        }

        return TelegramText::escape("{$label} — {$when}");
    }

    /**
     * Ред за българския пилот, когато е извън показаните позиции.
     */
    private function highlightLine(F2RaceSession $session, Collection $classified): ?string
    {
        /** @var array<int, string> $slugs */
        $slugs = (array) config('channel.highlight_driver_slugs', []);

        if ($slugs === []) {
            return null;
        }

        $result = $classified
            ->skip(self::VISIBLE_POSITIONS)
            ->first(fn (F2Result $r): bool => in_array($r->driver?->slug, $slugs, strict: true));

        if ($result === null) {
            return null;
        }

        $name = TelegramText::escape($this->name($result->driver));
        $position = (int) $result->position;

        return "🇧🇬 <b>{$name}</b> — {$position}-и";
    }

    /**
     * @return Collection<int, F2Result>
     */
    private function classified(F2RaceSession $session): Collection
    {
        return $session->results
            ->filter(fn (F2Result $result): bool => $result->position !== null)
            ->sortBy('position')
            ->values();
    }

    /**
     * @return Collection<int, string>
     */
    private function retired(F2RaceSession $session): Collection
    {
        return $session->results
            ->filter(fn (F2Result $result): bool => $result->position === null)
            ->map(fn (F2Result $result): string => $this->name($result->driver))
            ->filter()
            ->values();
    }

    private function resultLine(F2Result $result, F2SessionType $type): string
    {
        $position = (int) $result->position;
        $prefix = self::MEDALS[$position] ?? str_pad((string) $position, 2, ' ', STR_PAD_LEFT).'.';

        $driver = TelegramText::escape($this->name($result->driver));
        $team = TelegramText::escape($result->driver?->team?->name ?? '');

        $parts = ["{$prefix} <b>{$driver}</b>"];

        if ($team !== '') {
            $parts[] = $team;
        }

        // Победителят в състезание показва време, останалите — изоставане.
        // В тренировка и квалификация всеки има абсолютна обиколка.
        if (filled($result->time_or_gap)) {
            $parts[] = TelegramText::escape((string) $result->time_or_gap);
        }

        $line = implode(' · ', $parts);

        if ($type->isRace() && (float) $result->points > 0) {
            $line .= ' · '.TelegramText::escape($this->points((float) $result->points).' т.');
        }

        return $line;
    }

    private function name(?F2Driver $driver): string
    {
        if ($driver === null) {
            return '';
        }

        return DriverName::display($driver->slug, $driver->fullName());
    }

    /**
     * Само фамилията — за класирането, където три пълни имена не се събират
     * на един ред на телефон.
     */
    private function surname(F2Driver $driver): string
    {
        $display = $this->name($driver);
        $parts = preg_split('/\s+/', trim($display)) ?: [];

        return (string) (end($parts) ?: $display);
    }

    /**
     * „19" вместо „19,0"; „1,5" остава с десетичната.
     */
    private function points(float $points): string
    {
        return rtrim(rtrim(number_format($points, 1, ',', ''), '0'), ',');
    }

    /**
     * Страница на сайта за тази сесия.
     */
    private function url(F2RaceSession $session): ?string
    {
        $race = $session->race;

        if ($race === null) {
            return null;
        }

        return route('f2.race', [$race->slug, $session->session_type->urlSegment()]);
    }
}
