<?php

declare(strict_types=1);

namespace App\Services\LiveTiming;

use App\Enums\SessionType;
use App\Models\Constructor;
use App\Models\Driver;
use App\Models\Race;
use App\Models\RaceSession;
use App\Models\Season;
use App\Models\SessionResult;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * Класации от сесиите, които Jolpica не покрива: трите тренировки и спринт
 * квалификацията. Източник — OpenF1.
 *
 * ЛИЦЕНЗ: OpenF1 е CC BY-NC-SA 4.0 и изисква посочване на източника. Затова
 * постовете с тези данни носят атрибуция (виж ChannelPostKind). Употребата е
 * некомерсиална; ако сайтът някога вземе реклами, това трябва да се преразгледа
 * с тях (https://openf1.org/contact).
 *
 * ДОСТЪП: OpenF1 заключва ЦЕЛИЯ си API за неавтентикирани от 30 минути преди
 * до 30 минути след всяка сесия. Без OPENF1_USERNAME/OPENF1_PASSWORD синхронът
 * мълчи точно през уикенда, когато е нужен.
 *
 * Клиентът е защитен и връща празна колекция при всяка грешка, включително
 * 401 — затова празен резултат тук значи „още не" и се пробва пак, а не
 * „сесията няма класация". Причината се вижда в лога от клиента.
 */
class OpenF1SessionSync
{
    /**
     * Кои сесии взимаме. Квалификацията и състезанието идват от Jolpica,
     * който няма лицензно ограничение — не ги дублираме.
     *
     * Съпоставяме по МАЛКИ БУКВИ и по няколко варианта: OpenF1 подава
     * `session_name` както го дава Формула 1, а той се е менял в годините
     * („Sprint Shootout" стана „Sprint Qualifying"). Филтър по точен низ тук
     * е най-честият начин тази интеграция да замълчи без грешка.
     *
     * @var array<string, SessionType>
     */
    private const SESSION_NAMES = [
        'practice 1' => SessionType::FP1,
        'practice 2' => SessionType::FP2,
        'practice 3' => SessionType::FP3,
        'sprint qualifying' => SessionType::SprintQuali,
        'sprint shootout' => SessionType::SprintQuali,
        // Състезанието и спринтът се взимат за БЪРЗО показване, не за точките.
        // Jolpica публикува с часове закъснение, а дотогава сайтът и каналът
        // мълчат за резултат, който всички вече знаят. Класацията оттук отива
        // в `session_results` и се показва като временна, докато Jolpica
        // пристигне; точките, класирането и прогнозите остават негови.
        'sprint' => SessionType::Sprint,
        'race' => SessionType::Race,
    ];

    /**
     * Пълното съответствие — за разписанието в `race_sessions`.
     *
     * Таблицата стои празна от създаването си: никой синхрон не я е пълнил, а
     * началната страница я чете, за да покаже часовете на сесиите. OpenF1 ги
     * дава с точност до секундата, така че я пълним оттук.
     *
     * @var array<string, SessionType>
     */
    private const ALL_SESSION_NAMES = self::SESSION_NAMES + [
        'qualifying' => SessionType::Qualifying,
        'sprint' => SessionType::Sprint,
        'race' => SessionType::Race,
    ];

    /**
     * Отборите, които OpenF1 и Jolpica пишат различно: име в OpenF1 с малки
     * букви → `jolpica_id` на нашия конструктор. Еднаквите („Ferrari",
     * „McLaren") се намират по име и не са тук.
     *
     * Нужно е за пилотите без отбор в ростъра — новаците във FP1. Иначе Цолов
     * излиза в „Racing Bulls", а съотборникът му Линдблад в „RB F1 Team".
     *
     * @var array<string, string>
     */
    private const TEAM_ALIASES = [
        'red bull racing' => 'red_bull',
        'racing bulls' => 'rb',
        'alpine' => 'alpine',
        'cadillac' => 'cadillac',
    ];

    public function __construct(
        private readonly OpenF1Client $client,
    ) {}

    /**
     * @return array{sessions:int, results:int, skipped:int, errors:array<int, string>}
     */
    public function syncSeason(int $year): array
    {
        $stats = ['sessions' => 0, 'results' => 0, 'skipped' => 0, 'errors' => []];

        $season = Season::query()->where('year', $year)->first();

        if ($season === null) {
            $stats['errors'][] = "Няма сезон {$year} в базата — пусни първо f1:sync-season.";

            return $stats;
        }

        $all = $this->client->getSeasonSessions($year);

        if ($all->isEmpty()) {
            $stats['errors'][] = 'OpenF1 не върна сесии (възможно е да тече сесия и достъпът да е заключен).';

            return $stats;
        }

        // Веднъж за целия обход — съпоставянето по номер, код и име е в паметта.
        $roster = Driver::query()
            ->where('season_id', $season->id)
            ->with('constructor')
            ->get();
        $constructors = Constructor::query()->where('season_id', $season->id)->get();

        foreach ($all->groupBy('meeting_key') as $meetingSessions) {
            $race = $this->matchRace($season, $meetingSessions);

            if ($race === null) {
                $stats['skipped']++;

                continue;
            }

            $this->syncSchedule($race, $meetingSessions);

            foreach ($meetingSessions as $session) {
                $type = $this->sessionType($session);

                if ($type === null || ! $this->hasFinished($session)) {
                    continue;
                }

                try {
                    $count = $this->syncSession($roster, $constructors, $race, (int) $session['session_key'], $type);

                    if ($count > 0) {
                        $stats['sessions']++;
                        $stats['results'] += $count;
                    }
                } catch (Throwable $e) {
                    $stats['errors'][] = "кръг {$race->round} {$type->value}: {$e->getMessage()}";
                    Log::warning("OpenF1: провалена сесия [{$session['session_key']}]: {$e->getMessage()}");
                }
            }
        }

        return $stats;
    }

    /**
     * Съпоставя събитие от OpenF1 с наш кръг по датата на състезанието.
     *
     * По дата, а не по име на пистата: имената се пишат различно в двата
     * източника („Autodromo Nazionale Monza" срещу „monza"), а два Гран при
     * в един и същи ден не съществуват.
     *
     * @param  Collection<int, array<string, mixed>>  $sessions
     */
    private function matchRace(Season $season, Collection $sessions): ?Race
    {
        $raceSession = $sessions->first(
            fn ($s) => strtolower((string) ($s['session_name'] ?? '')) === 'race',
        );

        $date = $this->parseDate($raceSession['date_start'] ?? null)
            ?? $this->parseDate($sessions->first()['date_start'] ?? null);

        if ($date === null) {
            return null;
        }

        return Race::query()
            ->where('season_id', $season->id)
            ->whereNotNull('race_datetime_utc')
            ->whereBetween('race_datetime_utc', [
                $date->copy()->subDays(2),
                $date->copy()->addDays(2),
            ])
            ->first();
    }

    /**
     * Разписанието на уикенда в `race_sessions`.
     *
     * @param  Collection<int, array<string, mixed>>  $sessions
     */
    private function syncSchedule(Race $race, Collection $sessions): void
    {
        foreach ($sessions as $session) {
            $name = strtolower(trim((string) ($session['session_name'] ?? '')));
            $type = self::ALL_SESSION_NAMES[$name] ?? null;
            $start = $this->parseDate($session['date_start'] ?? null);

            if ($type === null || $start === null) {
                continue;
            }

            RaceSession::query()->updateOrCreate(
                ['race_id' => $race->id, 'type' => $type->value],
                ['scheduled_at_utc' => $start],
            );
        }
    }

    /**
     * @param  array<string, mixed>  $session
     */
    private function sessionType(array $session): ?SessionType
    {
        $name = strtolower(trim((string) ($session['session_name'] ?? '')));

        return self::SESSION_NAMES[$name] ?? null;
    }

    /**
     * Сесията е приключила и класацията ѝ вече не се мени.
     *
     * `date_end` е ПЛАНИРАНИЯТ край, не картираният флаг — при червен флаг
     * сесията го надхвърля. Затова добавяме резерв, който покрива и
     * 30-минутния прозорец, в който OpenF1 заключва достъпа.
     *
     * @param  array<string, mixed>  $session
     */
    private function hasFinished(array $session): bool
    {
        if (($session['is_cancelled'] ?? false) === true) {
            return false;
        }

        $end = $this->parseDate($session['date_end'] ?? null);

        return $end !== null && $end->addMinutes(35)->isPast();
    }

    /**
     * Класацията на една сесия, с всички карали в нея.
     *
     * Във FP1 отборите пускат новаци, които ги няма в ростъра — `drivers` е
     * ростърът на лигата за прогнози и там не им е мястото. Те влизат с
     * `driver_id` = null и с номер, име и отбор от OpenF1. Иначе класацията
     * излиза с дупки: Цолов, 12-и във FP1 в Мексико 2026, просто липсваше.
     *
     * Записът е в транзакция: ако един ред гръмне, класацията остава каквато
     * беше, вместо наполовина обновена до следващия синхрон.
     *
     * @param  Collection<int, Driver>  $roster
     * @param  Collection<int, Constructor>  $constructors
     */
    private function syncSession(Collection $roster, Collection $constructors, Race $race, int $sessionKey, SessionType $type): int
    {
        $rows = $this->client->getSessionResult($sessionKey);

        if ($rows->isEmpty()) {
            return 0;
        }

        // Класацията носи само номера на болида — имената идват отделно. Тук
        // сесията е приключила, затова списъкът се пази седмица, не 5 минути.
        $entrants = $this->client->getFinishedSessionDrivers($sessionKey)->keyBy('driver_number');
        $drivers = $this->matchRoster(
            $roster,
            $rows->map(fn (array $row): int => (int) $row['driver_number']),
            $entrants,
        );
        $teammates = $this->teammateTeams($entrants, $drivers);

        return DB::transaction(function () use ($rows, $entrants, $drivers, $teammates, $constructors, $race, $type): int {
            $existing = SessionResult::query()
                ->where('race_id', $race->id)
                ->where('session_type', $type->value)
                ->get();

            $count = 0;

            foreach ($rows as $row) {
                $number = (int) $row['driver_number'];
                $entrant = $entrants->get($number, []);
                $driver = $drivers[$number] ?? null;
                $name = $this->latinName($entrant) ?? $driver?->fullName();

                // Пилот извън ростъра, за когото OpenF1 не е дал име: не знаем кой
                // е. Следващият синхрон ще опита пак — пилотите се кешират 5 минути.
                if ($name === null) {
                    continue;
                }

                $result = $this->findRow($existing, $number, $driver);

                if ($result === null) {
                    $result = new SessionResult(['race_id' => $race->id, 'session_type' => $type->value]);
                    $existing->push($result);
                }

                if ($driver !== null) {
                    $this->releaseDriver($existing, $driver, $result);
                }

                $result->fill([
                    'driver_id' => $driver?->id,
                    'driver_number' => $number,
                    'driver_name' => $name,
                    'team_name' => $driver?->constructor?->name
                        ?? $this->teamName($entrant, $teammates, $constructors),
                    'position' => isset($row['position']) && $row['position'] !== null
                        ? (int) $row['position']
                        : null,
                    // В състезание `duration` е ОБЩОТО време, не обиколка —
                    // форматирано като „1:23.456" би било безсмислица. Там
                    // значение има само изоставането.
                    'best_time' => $type->isRace() ? null : $this->lapTime($row['duration'] ?? null),
                    'gap' => $this->gap($row['gap_to_leader'] ?? null),
                    'dnf' => (bool) ($row['dnf'] ?? false) || (bool) ($row['dns'] ?? false) || (bool) ($row['dsq'] ?? false),
                    'source' => 'openf1',
                ])->save();

                $count++;
            }

            return $count;
        });
    }

    /**
     * Кой от ростъра стои зад всеки номер в сесията.
     *
     * Първо по номер. После по трибуквения код, защото номерът се мени при смяна
     * на отбор в рамките на сезона по-често от кода. Накрая по име: резервите,
     * внесени от Jolpica, често нямат нито номер, нито код.
     *
     * Един пилот от ростъра стои зад най-много един номер. Иначе новак, чийто
     * код съвпада с този на титуляр, би презаписал реда на титуляра.
     *
     * @param  Collection<int, Driver>  $roster
     * @param  Collection<int, int>  $numbers
     * @param  Collection<int, array<string, mixed>>  $entrants
     * @return array<int, Driver>
     */
    private function matchRoster(Collection $roster, Collection $numbers, Collection $entrants): array
    {
        $byNumber = $roster->whereNotNull('permanent_number')->keyBy('permanent_number');
        $byCode = $roster->whereNotNull('driver_code')->keyBy('driver_code');
        $bySlug = $roster->keyBy('slug');

        $matched = [];

        foreach ($numbers as $number) {
            if ($byNumber->has($number)) {
                $matched[$number] = $byNumber->get($number);
            }
        }

        $taken = array_flip(array_map(fn (Driver $driver): int => $driver->id, $matched));

        foreach ($numbers as $number) {
            if (isset($matched[$number])) {
                continue;
            }

            $entrant = $entrants->get($number, []);
            $name = $this->latinName($entrant);

            $candidates = [
                $byCode->get((string) ($entrant['name_acronym'] ?? '')),
                $name !== null ? $bySlug->get(Str::slug($name)) : null,
            ];

            foreach ($candidates as $candidate) {
                if ($candidate !== null && ! isset($taken[$candidate->id])) {
                    $matched[$number] = $candidate;
                    $taken[$candidate->id] = true;

                    break;
                }
            }
        }

        return $matched;
    }

    /**
     * Съществуващият ред на болида в тази класация.
     *
     * В OpenF1 самоличността е номерът на болида. Така и новак, който по-късно
     * влезе в ростъра, запазва реда си, вместо да се появи втори. Редовете
     * отпреди номерът да се пази нямат такъв — само тях познаваме по пилота.
     *
     * @param  Collection<int, SessionResult>  $existing
     */
    private function findRow(Collection $existing, int $number, ?Driver $driver): ?SessionResult
    {
        return $existing->first(fn (SessionResult $row): bool => $row->driver_number === $number)
            ?? ($driver !== null
                ? $existing->first(fn (SessionResult $row): bool => $row->driver_number === null && $row->driver_id === $driver->id)
                : null);
    }

    /**
     * Маха пилота от всеки друг ред на класацията, преди да го запише на този.
     *
     * Пилотът сменя болида, когато номерът му в ростъра се смени (Jolpica
     * внася номера на резерва, щом той кара състезание) или когато се поправи
     * сгрешен. Без това unique индексът по пилот гърми и сесията засяда на
     * всеки синхрон. Старият ред остава със снимката си от OpenF1 и се
     * попълва наново, щом стигнем до неговия номер. Ред без номер (отпреди
     * миграцията) се изтрива — без пилот и без номер той не казва нищо.
     *
     * @param  Collection<int, SessionResult>  $existing
     */
    private function releaseDriver(Collection $existing, Driver $driver, SessionResult $keep): void
    {
        foreach ($existing as $index => $row) {
            if ($row === $keep || $row->driver_id !== $driver->id) {
                continue;
            }

            if ($row->driver_number === null) {
                $row->delete();
                $existing->forget($index);

                continue;
            }

            $row->update(['driver_id' => null]);
        }
    }

    /**
     * Отборите по съотборниците: име в OpenF1 → името на отбора в ростъра.
     *
     * Последна възможност за отбор, който OpenF1 нарича иначе и който не е в
     * TEAM_ALIASES (например след ребрандиране). Не е първа, защото съотборникът
     * може вече да е в друг отбор: при смяна по средата на сезона ростърът
     * помни новия му отбор, не този, за който е карал в сесията.
     *
     * @param  Collection<int, array<string, mixed>>  $entrants
     * @param  array<int, Driver>  $drivers
     * @return array<string, string>
     */
    private function teammateTeams(Collection $entrants, array $drivers): array
    {
        $names = [];

        foreach ($drivers as $number => $driver) {
            $theirs = $entrants->get($number)['team_name'] ?? null;
            $ours = $driver->constructor?->name;

            if (is_string($theirs) && $theirs !== '' && $ours !== null) {
                $names[$theirs] ??= $ours;
            }
        }

        return $names;
    }

    /**
     * Отборът на пилот без отбор в ростъра, както го пише сайтът.
     *
     * Първо същото име, после TEAM_ALIASES, после съотборник от сесията. Ако
     * нищо не съвпадне, остава името от OpenF1 — по-добре от празно.
     *
     * @param  array<string, mixed>  $entrant
     * @param  array<string, string>  $teammates
     * @param  Collection<int, Constructor>  $constructors
     */
    private function teamName(array $entrant, array $teammates, Collection $constructors): ?string
    {
        $theirs = trim((string) ($entrant['team_name'] ?? ''));

        if ($theirs === '') {
            return null;
        }

        $key = mb_strtolower($theirs);
        $alias = self::TEAM_ALIASES[$key] ?? null;

        $ours = $constructors->first(fn (Constructor $constructor): bool => mb_strtolower($constructor->name) === $key)
            ?? ($alias !== null ? $constructors->firstWhere('jolpica_id', $alias) : null);

        return $ours?->name ?? $teammates[$theirs] ?? $theirs;
    }

    /**
     * Латинското име, както го пише сайтът — „Nikola Tsolov".
     *
     * @param  array<string, mixed>  $entrant
     */
    private function latinName(array $entrant): ?string
    {
        $name = trim(((string) ($entrant['first_name'] ?? '')).' '.((string) ($entrant['last_name'] ?? '')));

        // `full_name` е с фамилия в главни букви: „Nikola TSOLOV".
        if ($name === '' && filled($entrant['full_name'] ?? null)) {
            $name = Str::title(mb_strtolower(trim((string) $entrant['full_name'])));
        }

        return $name !== '' ? $name : null;
    }

    /**
     * Секунди във вид „1:23.456".
     *
     * Масив означава квалификационна сесия ([Q1, Q2, Q3]). Взимаме ПОСЛЕДНАТА
     * изкарана отсечка, а не най-бързата: позицията се определя от нея, а
     * времената от различни отсечки не са сравними помежду си. Същото правим
     * и при данните от Jolpica (Q3, иначе Q2, иначе Q1).
     */
    private function lapTime(mixed $duration): ?string
    {
        if (is_array($duration)) {
            $last = collect($duration)->filter(fn ($v) => is_numeric($v) && (float) $v > 0)->last();

            return $last !== null ? $this->lapTime($last) : null;
        }

        if (! is_numeric($duration) || (float) $duration <= 0) {
            return null;
        }

        $seconds = (float) $duration;
        $minutes = (int) floor($seconds / 60);

        return $minutes > 0
            ? sprintf('%d:%06.3f', $minutes, $seconds - $minutes * 60)
            : sprintf('%.3f', $seconds);
    }

    /**
     * Изоставането може да е число (секунди), масив (по отсечки) или низ
     * („+1 LAP") — виж коментара при getSessionResult.
     */
    private function gap(mixed $gap): ?string
    {
        if (is_array($gap)) {
            $gap = collect($gap)->first(fn ($v) => is_numeric($v));
        }

        if (is_string($gap) && $gap !== '') {
            return $gap;
        }

        if (! is_numeric($gap) || (float) $gap <= 0) {
            return null;
        }

        return '+'.sprintf('%.3f', (float) $gap);
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
