<?php

declare(strict_types=1);

namespace App\Services\LiveTiming;

use App\Models\Race;
use Illuminate\Support\Carbon;
use Throwable;

/**
 * Имаше ли safety car в състезанието — от съобщенията на дирекцията в OpenF1.
 *
 * Jolpica не дава тази информация, затова `races.had_safety_car` се
 * попълваше на ръка — и до 26.09.2026 не беше попълнено нито веднъж.
 *
 * Отговорът е „не знам" (null) винаги, когато данните може да са непълни:
 * сезон без данни в OpenF1, несъпоставено събитие, сесия, която не е
 * приключила, или дирекция без карирания флаг. „Не" излиза само когато цялото
 * състезание е налично и в него няма safety car. Иначе отговор, дръпнат по
 * средата на състезанието, щеше да раздаде грешни точки завинаги.
 */
class SafetyCarDetector
{
    /** OpenF1 има данни от сезон 2023 нататък. */
    private const FIRST_SEASON = 2023;

    /**
     * Колко след планирания край на сесията чакаме. Червен флаг я удължава,
     * а OpenF1 държи данните заключени 30 минути след края.
     */
    private const SETTLE_MINUTES = 35;

    /** Два Гран при в рамките на два дни няма — същото правило като в OpenF1SessionSync. */
    private const MATCH_WINDOW_HOURS = 48;

    public function __construct(private readonly OpenF1Client $client) {}

    /**
     * Отговорът за точкуването според правилото в config/predictions.php.
     */
    public function detect(Race $race): ?bool
    {
        return $this->decide($this->inspect($race));
    }

    /**
     * Правилото, приложено върху вече прочетеното от inspect().
     *
     * @param  array{safety_car: bool, virtual_safety_car: bool}|null  $seen
     */
    public function decide(?array $seen): ?bool
    {
        if ($seen === null) {
            return null;
        }

        return $seen['safety_car']
            || ((bool) config('predictions.safety_car.count_virtual') && $seen['virtual_safety_car']);
    }

    /**
     * Какво точно е имало, разделено на истински и виртуален safety car.
     *
     * @return array{safety_car: bool, virtual_safety_car: bool}|null
     */
    public function inspect(Race $race): ?array
    {
        $raceAt = $race->race_datetime_utc;
        $year = $race->season?->year;

        if ($raceAt === null || $year === null || $year < self::FIRST_SEASON) {
            return null;
        }

        $sessionKey = $this->findFinishedRaceSession((int) $year, Carbon::parse($raceAt));

        if ($sessionKey === null) {
            return null;
        }

        $messages = $this->client->getRaceControlUncached($sessionKey);

        // Без карирания флаг данните не са окончателни (или състезанието е
        // прекратено) — тогава решава човек във Filament.
        $finished = $messages->contains(
            fn (array $message): bool => strtoupper((string) ($message['flag'] ?? '')) === 'CHEQUERED',
        );

        if (! $finished) {
            return null;
        }

        $texts = $messages->map(fn (array $message): string => strtoupper((string) ($message['message'] ?? '')));

        $deployments = $texts->filter(
            fn (string $text): bool => str_contains($text, 'SAFETY CAR DEPLOYED') || str_contains($text, 'VSC DEPLOYED'),
        );

        // Текстът е единственият надежден признак: категорията е „SafetyCar"
        // и за двата вида, а виртуалният се пише ту „VSC DEPLOYED", ту
        // „VIRTUAL SAFETY CAR DEPLOYED" според годината.
        $isVirtual = fn (string $text): bool => str_contains($text, 'VIRTUAL') || str_contains($text, 'VSC');

        return [
            'safety_car' => $deployments->contains(fn (string $text): bool => ! $isVirtual($text))
                || $texts->contains(fn (string $text): bool => $this->isStartBehindSafetyCar($text)),
            'virtual_safety_car' => $deployments->contains($isVirtual),
        ];
    }

    /**
     * Старт или рестарт зад safety car-а.
     *
     * За него OpenF1 НЕ пише „SAFETY CAR DEPLOYED": при мокрия старт в Спа
     * 2025 колата водеше колоната няколко обиколки, а в дирекцията има само
     * „RACE WILL START BEHIND THE SAFETY CAR" и „ROLLING START". Rolling start
     * по правилник винаги е зад safety car-а. Formation lap зад него, последван
     * от стоящ старт (Силвърстоун 2025), не се брои — това не е обиколка от
     * състезанието.
     */
    private function isStartBehindSafetyCar(string $text): bool
    {
        return str_contains($text, 'ROLLING START')
            || str_contains($text, 'RACE WILL START BEHIND THE SAFETY CAR')
            || str_contains($text, 'RESUME BEHIND THE SAFETY CAR');
    }

    /**
     * session_key на главното състезание (не на спринта), само ако е
     * приключило достатъчно отдавна.
     */
    private function findFinishedRaceSession(int $year, Carbon $raceAt): ?int
    {
        $session = $this->client->getSeasonSessions($year)
            ->filter(fn (array $session): bool => strtolower(trim((string) ($session['session_name'] ?? ''))) === 'race'
                && ($session['is_cancelled'] ?? false) !== true)
            ->map(fn (array $session): array => [
                'key' => (int) $session['session_key'],
                'start' => $this->parseDate($session['date_start'] ?? null),
                'end' => $this->parseDate($session['date_end'] ?? null),
            ])
            ->filter(fn (array $session): bool => $session['start'] !== null
                && abs($session['start']->diffInHours($raceAt)) <= self::MATCH_WINDOW_HOURS)
            ->sortBy(fn (array $session): float => abs($session['start']->diffInSeconds($raceAt)))
            ->first();

        if ($session === null || $session['end'] === null) {
            return null;
        }

        return $session['end']->copy()->addMinutes(self::SETTLE_MINUTES)->isPast()
            ? $session['key']
            : null;
    }

    private function parseDate(mixed $value): ?Carbon
    {
        if (! is_string($value) || $value === '') {
            return null;
        }

        try {
            return Carbon::parse($value)->utc();
        } catch (Throwable) {
            return null;
        }
    }
}
