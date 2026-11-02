<?php

declare(strict_types=1);

namespace App\Services\LiveTiming;

use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Клиент за OpenF1 API (https://openf1.org) — live timing данни за текущата сесия.
 *
 * Защитно кодиране: ВСЯКА заявка е в try/catch, кешира се (rate-limit safety) и
 * при провал връща null/празна колекция + лог — никога не хвърля и не показва
 * остарели данни като пресни.
 */
class OpenF1Client
{
    /** Опити при 429. Повече от три само удължават агонията. */
    private const MAX_ATTEMPTS = 3;

    /** Изчакване след 429, умножено по номера на опита. */
    private const RETRY_BACKOFF_MS = 1500;

    /**
     * Най-малкото разстояние между две заявки, по подразбиране.
     *
     * ВАЖНО: ограничението, което хапе, е това за МИНУТА, не за секунда.
     * OpenF1 позволява 6 заявки/сек и 60/мин на платения тир (3 и 30 на
     * безплатния). Един рекап прави шестнайсет заявки, тоест при разстояние от
     * 220 ms се движим с 4,5 в секунда — под секундния таван, но 270 в минута,
     * четири пъти над минутния. Точно това докара 429 на championship_drivers,
     * championship_teams и intervals на прода, а после и на car_data.
     *
     * 1100 ms дава около 54 заявки в минута — под тавана с резерв. Рекапът
     * става ~20 секунди вместо ~4, което няма значение за нещо, което върви
     * веднъж на две седмици от крон.
     *
     * На безплатния тир (30/мин) сложи 2100 в services.openf1.min_interval_ms.
     */
    private const DEFAULT_MIN_INTERVAL_MS = 1100;

    /**
     * Кога тръгна последната заявка, за целия процес.
     *
     * Статично нарочно: клиентът не е singleton и в един рекап участват по
     * няколко негови копия (fetcher, telemetry builder). Ако разстоянието се
     * пазеше в инстанция, всяко копие щеше да брои отделно и лимитът пак щеше
     * да се удря.
     */
    private static ?float $lastRequestAt = null;

    private string $baseUrl;

    private int $timeout;

    public function __construct(private readonly OpenF1TokenManager $tokens)
    {
        $this->baseUrl = rtrim((string) config('services.openf1.base_url'), '/');
        $this->timeout = (int) config('services.openf1.timeout', 10);
    }

    /**
     * Текущата (последна) сесия. null ако няма или при грешка.
     *
     * @return array{key:int, name:string, type:string, date_start:?Carbon, date_end:?Carbon, meeting_key:?int, circuit_short_name:?string}|null
     */
    public function getCurrentSession(): ?array
    {
        return Cache::remember('openf1:current-session', now()->addSeconds(60), function () {
            $rows = $this->get('sessions', ['session_key' => 'latest']);

            $session = $rows->first();

            if (! is_array($session) || ! isset($session['session_key'])) {
                return null;
            }

            return [
                'key' => (int) $session['session_key'],
                'name' => (string) ($session['session_name'] ?? 'Сесия'),
                'type' => (string) ($session['session_type'] ?? ''),
                'date_start' => $this->parseDate($session['date_start'] ?? null),
                'date_end' => $this->parseDate($session['date_end'] ?? null),
                'meeting_key' => isset($session['meeting_key']) ? (int) $session['meeting_key'] : null,
                'circuit_short_name' => $session['circuit_short_name'] ?? null,
            ];
        });
    }

    /**
     * Текущата сесия само ако е АКТИВНА в момента (буфер: 30 мин преди старт до
     * 30 мин след край). Без дати → приемаме я за активна (защитно). null иначе.
     *
     * @return array{key:int, name:string, type:string, date_start:?Carbon, date_end:?Carbon, meeting_key:?int, circuit_short_name:?string}|null
     */
    public function getLiveSession(): ?array
    {
        $session = $this->getCurrentSession();

        if ($session === null) {
            return null;
        }

        $start = $session['date_start'];
        $end = $session['date_end'];

        if ($start === null || $end === null) {
            return $session;
        }

        return now()->between($start->copy()->subMinutes(30), $end->copy()->addMinutes(30))
            ? $session
            : null;
    }

    /**
     * Пилотите в сесията. Кеш 5 мин (рядко се мени по време на сесия).
     *
     * `full_name` идва с фамилия в главни букви („Nikola TSOLOV"); за показване
     * са `first_name` и `last_name`.
     *
     * @return Collection<int, array{driver_number:int, name_acronym:?string, full_name:?string, first_name:?string, last_name:?string, team_name:?string, team_colour:?string}>
     */
    public function getSessionDrivers(int $sessionKey): Collection
    {
        return Cache::remember("openf1:drivers:{$sessionKey}", now()->addMinutes(5), function () use ($sessionKey) {
            return $this->get('drivers', ['session_key' => $sessionKey])
                ->filter(fn ($d) => is_array($d) && isset($d['driver_number']))
                ->map(fn ($d) => [
                    'driver_number' => (int) $d['driver_number'],
                    'name_acronym' => $d['name_acronym'] ?? null,
                    'full_name' => $d['full_name'] ?? null,
                    'first_name' => $d['first_name'] ?? null,
                    'last_name' => $d['last_name'] ?? null,
                    'team_name' => $d['team_name'] ?? null,
                    'team_colour' => isset($d['team_colour']) ? '#'.ltrim((string) $d['team_colour'], '#') : null,
                ])
                ->values();
        });
    }

    /**
     * Всички сесии от даден сезон — календар с точни начало и край.
     *
     * Кешът е дълъг нарочно: OpenF1 обновява разписанието веднъж дневно в
     * полунощ UTC, а безплатният лимит е 30 заявки в минута. Кратък кеш тук
     * би го изял без никаква полза.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getSeasonSessions(int $year): Collection
    {
        return Cache::remember("openf1:sessions:{$year}", now()->addMinutes(30), function () use ($year) {
            return $this->get('sessions', ['year' => $year])
                ->filter(fn ($s) => is_array($s) && isset($s['session_key']))
                ->values();
        });
    }

    /**
     * Крайната класация на сесия — позиция за всеки пилот.
     *
     * Работи за ВСИЧКИ видове сесии, включително тренировките и спринт
     * квалификацията, което Jolpica изобщо не покрива.
     *
     * ВНИМАНИЕ при ползване: `duration` и `gap_to_leader` НЕ са с постоянен тип.
     * В тренировка са число (най-добра обиколка в секунди), в квалификация са
     * масив от три стойности [Q1, Q2, Q3], а в състезание изоставането може да
     * е низ като „+1 LAP". Обработвай ги като mixed.
     *
     * Кешът е 6 часа: класацията на приключила сесия не се мени, а повторното
     * дърпане на всяка сесия от уикенда би изчерпало лимита.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getSessionResult(int $sessionKey): Collection
    {
        return Cache::remember("openf1:session-result:{$sessionKey}", now()->addHours(6), function () use ($sessionKey) {
            return $this->get('session_result', ['session_key' => $sessionKey])
                ->filter(fn ($r) => is_array($r) && isset($r['driver_number']))
                ->values();
        });
    }

    /**
     * Всички обиколки в сесията. Кеш 5 секунди (rate-limit safety).
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getLatestLaps(int $sessionKey): Collection
    {
        return Cache::remember("openf1:laps:{$sessionKey}", now()->addSeconds(5), function () use ($sessionKey) {
            return $this->get('laps', ['session_key' => $sessionKey])
                ->filter(fn ($l) => is_array($l) && isset($l['driver_number']))
                ->values();
        });
    }

    /**
     * Позиции по трасето. OpenF1 записва ред само при ПРОМЯНА на позицията,
     * така че цялата сесия е поносим обем. Кеш 5 секунди.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getPositions(int $sessionKey): Collection
    {
        return Cache::remember("openf1:positions:{$sessionKey}", now()->addSeconds(5), function () use ($sessionKey) {
            return $this->get('position', ['session_key' => $sessionKey])
                ->filter(fn ($p) => is_array($p) && isset($p['driver_number'], $p['position']))
                ->values();
        });
    }

    /**
     * Интервали (изоставане от лидера / от предния). Само за състезания, ~на 4
     * секунди за всеки пилот — затова дърпаме единствено последните минути;
     * цяло състезание са десетки хиляди записа. Кеш 5 секунди.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getIntervals(int $sessionKey): Collection
    {
        return Cache::remember("openf1:intervals:{$sessionKey}", now()->addSeconds(5), function () use ($sessionKey) {
            return $this->get('intervals', [
                'session_key' => $sessionKey,
                // OpenF1 носи оператора в ИМЕТО на параметъра („date>“), не в стойността.
                'date>' => now()->subMinutes(3)->utc()->toIso8601String(),
            ])
                ->filter(fn ($i) => is_array($i) && isset($i['driver_number']))
                ->values();
        });
    }

    /**
     * Стинтове (гумени състави) по пилот. Кеш 30 секунди.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getStints(int $sessionKey): Collection
    {
        return Cache::remember("openf1:stints:{$sessionKey}", now()->addSeconds(30), function () use ($sessionKey) {
            return $this->get('stints', ['session_key' => $sessionKey])
                ->filter(fn ($s) => is_array($s) && isset($s['driver_number']))
                ->values();
        });
    }

    /*
    |--------------------------------------------------------------------------
    | Исторически данни (приключила сесия)
    |--------------------------------------------------------------------------
    |
    | OpenF1 смята данните за „живи“ от 30 минути преди началото до 30 минути
    | след края на сесия. Извън този прозорец те са исторически: безплатни, без
    | автентикация и НЕИЗМЕННИ. Затова методите тук ползват 24-часов кеш вместо
    | секундите на живите — рекапът се сглобява веднъж и повторното пускане на
    | командата не хаби лимита (3 заявки/сек, 30/мин на безплатния тир).
    |
    | Не ползвай тези методи по време на сесия: ще заключат стар отговор за цял
    | ден. За живото има отделни методи по-горе.
    |
    */

    /**
     * Обиколките на приключила сесия — същият endpoint като getLatestLaps(),
     * но с дълъг кеш и отделен ключ.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getFinishedLaps(int $sessionKey): Collection
    {
        return $this->historical('laps', $sessionKey, fn ($r) => isset($r['driver_number'], $r['lap_number']));
    }

    /**
     * Стинтовете на приключила сесия (състав, начална и крайна обиколка,
     * възраст на гумата при поставяне).
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getFinishedStints(int $sessionKey): Collection
    {
        return $this->historical('stints', $sessionKey, fn ($r) => isset($r['driver_number']));
    }

    /**
     * Пилотите в сесията — име, номер, отбор и цвят на отбора (hex без диез).
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getFinishedDrivers(int $sessionKey): Collection
    {
        return $this->historical('drivers', $sessionKey, fn ($r) => isset($r['driver_number']));
    }

    /**
     * Влизания в пит лейна.
     *
     * ВНИМАНИЕ: през сезон 2026 `stop_duration` е null навсякъде — времето на
     * стоене не съществува в данните. `lane_duration` (цялото време в лейна) е
     * налично, но е замърсено от червени флагове: реалните стойности са 12-35
     * секунди, а спрелите зад червен флаг излизат с хиляди. Филтрирай.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getPitStops(int $sessionKey): Collection
    {
        return $this->historical('pit', $sessionKey, fn ($r) => isset($r['driver_number'], $r['lap_number']));
    }

    /**
     * Съобщенията на дирекцията — safety car, флагове, наказания.
     *
     * Оттук излизат прозорците на неутрализация, които всички останали графики
     * трябва да изрежат: обиколка зад safety car не е показател за темпо.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getRaceControl(int $sessionKey): Collection
    {
        return $this->historical('race_control', $sessionKey, fn ($r) => isset($r['date']));
    }

    /**
     * Същото като getRaceControl(), но без кеш — за решения, които се
     * записват в базата (safety car за точкуването на прогнозите).
     *
     * Дневният кеш пази всякакъв отговор, включително празния при провал и
     * частичния, ако е дръпнат преди финала. За графика това е поносимо; за
     * точки не е — грешният отговор щеше да се запише завинаги. Викащият
     * решава кога данните са окончателни (виж SafetyCarDetector).
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getRaceControlUncached(int $sessionKey): Collection
    {
        return $this->get('race_control', ['session_key' => $sessionKey])
            ->filter(fn ($r) => is_array($r) && isset($r['date']))
            ->values();
    }

    /**
     * Метеото над пистата — по един запис в минута, покрива и часа преди старта.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getWeather(int $sessionKey): Collection
    {
        return $this->historical('weather', $sessionKey, fn ($r) => isset($r['date']));
    }

    /**
     * Стартовата решетка.
     *
     * ВНИМАНИЕ: пита се със session_key на КВАЛИФИКАЦИЯТА, не на състезанието —
     * с ключа на състезанието endpoint-ът връща празно.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getStartingGrid(int $qualifyingSessionKey): Collection
    {
        return $this->historical('starting_grid', $qualifyingSessionKey, fn ($r) => isset($r['driver_number']));
    }

    /**
     * Смени на позиции по време на състезанието.
     *
     * Наборът включва и размени от питстопове и наказания след финала, затова
     * не го наричай „изпреварвания“ пред потребителя.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getOvertakes(int $sessionKey): Collection
    {
        return $this->historical('overtakes', $sessionKey, fn ($r) => isset($r['overtaking_driver_number']));
    }

    /**
     * Шампионатът при пилотите преди и след състезанието (beta endpoint).
     * Съществува само за състезателни сесии.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getChampionshipDrivers(int $sessionKey): Collection
    {
        return $this->historical('championship_drivers', $sessionKey, fn ($r) => isset($r['driver_number']));
    }

    /**
     * Шампионатът при конструкторите преди и след състезанието (beta endpoint).
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getChampionshipTeams(int $sessionKey): Collection
    {
        return $this->historical('championship_teams', $sessionKey, fn ($r) => isset($r['team_name']));
    }

    /**
     * Телеметрия на болида в ТЕСЕН времеви прозорец — скорост, газ, спирачка,
     * предавка, обороти на ~3,7 Hz.
     *
     * Прозорецът е задължителен и това не е удобство: цялото състезание за
     * един пилот е ~24 000 записа, а за двадесет и двама е половин милион.
     * Една обиколка е ~325 записа и 37 KB. Тегли обиколки, не състезания.
     *
     * ВНИМАНИЕ: през сезон 2026 полето `drs` е null навсякъде — регламентът
     * махна DRS, така че от този endpoint не може да се извади DRS графика.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getCarData(int $sessionKey, int $driverNumber, Carbon $from, Carbon $to): Collection
    {
        return $this->window('car_data', $sessionKey, $driverNumber, $from, $to);
    }

    /**
     * Позиция на болида по трасето (x, y, z) в тесен прозорец, ~3,7 Hz.
     *
     * Координатната система е същата като на очертанието от MultiViewer, така
     * че двете се наслагват без преобразуване. Документацията предупреждава,
     * че няма странична точност — не се вижда от коя страна на пистата е
     * болидът, така че става за линия по трасето, не за анализ на траектория.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getLocation(int $sessionKey, int $driverNumber, Carbon $from, Carbon $to): Collection
    {
        return $this->window('location', $sessionKey, $driverNumber, $from, $to);
    }

    /**
     * Изоставането от лидера и от предния на всеки ~4 секунди.
     *
     * Цяло състезание е ~22 000 записа и 3 MB. Дърпа се веднъж след кръга и от
     * него се извеждат само числа (най-дългата близка битка) — суровите редове
     * не се пазят.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getRaceIntervals(int $sessionKey): Collection
    {
        return $this->historical('intervals', $sessionKey, fn ($r) => isset($r['driver_number'], $r['date']));
    }

    /**
     * Радио разговорите. Документацията предупреждава, че през 2026 покритието
     * е рухнало и повечето събития нямат нито един запис — затова липсата тук
     * е нормално състояние, не грешка.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function getTeamRadio(int $sessionKey): Collection
    {
        return $this->historical('team_radio', $sessionKey, fn ($r) => isset($r['driver_number'], $r['recording_url']));
    }

    /**
     * Заявка за един пилот в тесен времеви прозорец.
     *
     * OpenF1 носи оператора в ИМЕТО на параметъра („date>“), не в стойността —
     * затова ключовете изглеждат странно, но точно така се филтрира.
     *
     * @return Collection<int, array<string, mixed>>
     */
    private function window(string $endpoint, int $sessionKey, int $driverNumber, Carbon $from, Carbon $to): Collection
    {
        // Query-то се сглобява РЪЧНО и се подава като низ. Причината е конкретна
        // и струваше един тих провал на прода: операторът е част от ИМЕТО на
        // параметъра („date>="), а http_build_query го кодира до „date%3E%3D=",
        // тоест с още едно кодирано равно. OpenF1 не разпознава това име и
        // връща 404 — телеметрията и картата по скорост просто липсваха.
        //
        // Подаден като низ, Guzzle не пипа заявката отвъд „>“ → „%3E“, което
        // API-то декодира правилно. Часовете са в Zulu формат, за да няма „+“
        // в стойността.
        $stamp = fn (Carbon $at): string => $at->utc()->format('Y-m-d\TH:i:s\Z');
        $query = sprintf(
            'session_key=%d&driver_number=%d&date>=%s&date<=%s',
            $sessionKey,
            $driverNumber,
            $stamp($from),
            $stamp($to),
        );

        $key = "openf1:hist:{$endpoint}:{$sessionKey}:{$driverNumber}:".md5($query);

        return $this->remembered($key, fn () => $this->get($endpoint, $query)
            ->filter(fn ($r) => is_array($r) && isset($r['date']))
            ->values());
    }

    /**
     * Обща обвивка за исторически заявки: дълъг кеш и общ филтър за форма.
     *
     * @param  callable(array<string, mixed>): bool  $keep
     * @return Collection<int, array<string, mixed>>
     */
    private function historical(string $endpoint, int $sessionKey, callable $keep): Collection
    {
        return $this->remembered(
            "openf1:hist:{$endpoint}:{$sessionKey}",
            fn () => $this->get($endpoint, ['session_key' => $sessionKey])
                ->filter(fn ($r) => is_array($r) && $keep($r))
                ->values(),
        );
    }

    /**
     * Кеш за 24 часа — освен когато е изключен.
     *
     * Изключва се при наваксване назад: тогава всеки отговор се чете точно
     * веднъж, а кешът по подразбиране е в базата и седемдесет уикенда биха
     * налели стотици мегабайти в таблицата `cache` без никаква полза.
     * Виж config/race-data.php.
     *
     * @param  callable(): Collection<int, mixed>  $fetch
     * @return Collection<int, mixed>
     */
    private function remembered(string $key, callable $fetch): Collection
    {
        if (! config('race-data.cache_historical', true)) {
            return $fetch();
        }

        return Cache::remember($key, now()->addDay(), $fetch);
    }

    /**
     * Изпълнява GET заявка защитено. Връща празна колекция при всяка грешка.
     *
     * `$query` може да е масив (обичайният случай) или готов НИЗ — низът се
     * ползва там, където операторът е част от името на параметъра и не бива да
     * минава през http_build_query. Виж window().
     *
     * @param  array<string, mixed>|string  $query
     * @return Collection<int, mixed>
     */
    private function get(string $endpoint, array|string $query): Collection
    {
        try {
            for ($attempt = 1; $attempt <= self::MAX_ATTEMPTS; $attempt++) {
                $this->throttle();

                $request = Http::acceptJson()->timeout($this->timeout);

                // OpenF1 изисква OAuth2 Bearer токен по време на живи сесии (иначе 401).
                $token = $this->tokens->getToken();
                if ($token !== null) {
                    $request = $request->withToken($token);
                }

                $response = $request->get("{$this->baseUrl}/{$endpoint}", $query);

                // 401 → токенът може да е изтекъл; изчистваме го за следващия опит.
                if ($response->status() === 401) {
                    $this->tokens->forget();
                }

                // 429 е единственото, което си струва да се повтори: рекапът
                // прави шестнайсет заявки за секунди и лимитът е 6/сек.
                // Останалите грешки няма да се оправят от само себе си.
                if ($response->status() === 429 && $attempt < self::MAX_ATTEMPTS) {
                    usleep(self::RETRY_BACKOFF_MS * $attempt * 1000);

                    continue;
                }

                if (! $response->successful()) {
                    Log::warning('OpenF1 заявка неуспешна', [
                        'endpoint' => $endpoint,
                        'status' => $response->status(),
                        'attempts' => $attempt,
                    ]);

                    return collect();
                }

                $data = $response->json();

                return is_array($data) ? collect($data) : collect();
            }

            return collect();
        } catch (Throwable $e) {
            Log::warning('OpenF1 заявка хвърли изключение', ['endpoint' => $endpoint, 'error' => $e->getMessage()]);

            return collect();
        }
    }

    /**
     * Разрежда заявките, за да не се удря лимитът на OpenF1.
     *
     * Изчаква само толкова, колкото не е минало от предишната заявка — при
     * бавен отговор изобщо не спи.
     */
    private function throttle(): void
    {
        // В тестовете заявките са фалшиви и няма кой да ни ограничи — спането
        // там само удължава набора (наблюдавано: 5 секунди стават 70).
        if (app()->runningUnitTests()) {
            return;
        }

        $interval = ((int) config('services.openf1.min_interval_ms', self::DEFAULT_MIN_INTERVAL_MS)) / 1000;

        if (self::$lastRequestAt !== null) {
            $elapsed = microtime(true) - self::$lastRequestAt;

            if ($elapsed < $interval) {
                usleep((int) (($interval - $elapsed) * 1_000_000));
            }
        }

        self::$lastRequestAt = microtime(true);
    }

    private function parseDate(?string $value): ?Carbon
    {
        if ($value === null) {
            return null;
        }

        try {
            return Carbon::parse($value);
        } catch (Throwable) {
            return null;
        }
    }
}
