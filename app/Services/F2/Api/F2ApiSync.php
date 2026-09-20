<?php

declare(strict_types=1);

namespace App\Services\F2\Api;

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2Race;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use App\Models\F2Team;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * Синхрон на F2 сезон от официалния резултатен API.
 *
 * Заменя F2WikipediaSync за текущия сезон: и четирите сесии вместо две,
 * минути вместо ден, и готови класирания вместо да ги смятаме сами.
 * Wikipedia остава за сезоните преди 2026 г., които API-то не покрива.
 *
 * Идемпотентен. Грешка в един кръг не спира останалите — записва се в
 * `errors` и обработката продължава.
 */
class F2ApiSync
{
    /** @var array{rounds:int, sessions:int, results:int, skipped_drivers:int, errors:array<int, string>} */
    private array $stats = ['rounds' => 0, 'sessions' => 0, 'results' => 0, 'skipped_drivers' => 0, 'errors' => []];

    public function __construct(
        private readonly F2ApiClient $client,
    ) {}

    /**
     * @param  callable|null  $onRound  fn (int $round, string $name, int $sessions): void
     * @return array{season:int, rounds:int, sessions:int, results:int, skipped_drivers:int, errors:array<int, string>}
     *
     * @throws F2ApiException
     */
    public function syncSeason(int $year, ?callable $onRound = null): array
    {
        $this->stats = ['rounds' => 0, 'sessions' => 0, 'results' => 0, 'skipped_drivers' => 0, 'errors' => []];

        $meetings = $this->client->meetings($year);

        if ($meetings === []) {
            $this->stats['errors'][] = "API-то няма данни за сезон {$year} (покритието започва от 2026).";

            return ['season' => $year, ...$this->stats];
        }

        $season = $this->season($year);

        foreach ($meetings as $meeting) {
            // Тестовите събития нямат кръг и биха разместили номерацията.
            if ((bool) ($meeting['isTestEvent'] ?? false)) {
                continue;
            }

            $round = $this->roundNumber($meeting);

            if ($round === null) {
                continue;
            }

            try {
                $sessions = $this->syncRound($season, $meeting, $round);
                $this->stats['rounds']++;

                if ($onRound !== null) {
                    $onRound($round, (string) ($meeting['meetingName'] ?? ''), $sessions);
                }
            } catch (Throwable $e) {
                $this->stats['errors'][] = "кръг {$round}: {$e->getMessage()}";
                Log::warning("F2 API: провален кръг [{$round}] от сезон {$year}: {$e->getMessage()}");
            }
        }

        $this->syncStandings($season);

        return ['season' => $year, ...$this->stats];
    }

    /**
     * Номерът на кръга идва от `roundText` („ROUND 9").
     *
     * НЕ ползвай `meetingNumber` — то е номерът на събитието във Формула 1
     * (за Унгария 2026: 11), а F2 не кара на всеки Гран при. Двете се
     * разминават и подмяната би разместила целия календар.
     *
     * @param  array<string, mixed>  $meeting
     */
    private function roundNumber(array $meeting): ?int
    {
        if (preg_match('/(\d+)/', (string) ($meeting['roundText'] ?? ''), $matches) !== 1) {
            return null;
        }

        return (int) $matches[1];
    }

    private function season(int $year): F2Season
    {
        $isCurrent = $year >= (int) (F2Season::query()->max('year') ?? $year);

        $season = F2Season::query()->updateOrCreate(['year' => $year], ['is_current' => $isCurrent]);

        if ($isCurrent) {
            F2Season::query()->where('id', '!=', $season->id)->update(['is_current' => false]);
        }

        return $season;
    }

    /**
     * @param  array<string, mixed>  $meeting
     */
    private function syncRound(F2Season $season, array $meeting, int $round): int
    {
        $meetingKey = (string) ($meeting['meetingKey'] ?? '');
        $location = (string) ($meeting['meetingLocation'] ?? $meeting['meetingName'] ?? '');
        $offset = (string) ($meeting['gmtOffset'] ?? '+00:00');

        $apiSessions = (array) ($meeting['meetingSessions'] ?? []);

        // Датата на кръга = началото на главното състезание, не meetingStartDate:
        // календарът на сайта подрежда по нея и трябва да сочи същия момент,
        // който показваме като „състезание".
        $featureStart = null;

        foreach ($apiSessions as $apiSession) {
            if (F2SessionType::fromApiCode((string) ($apiSession['session'] ?? '')) === F2SessionType::FeatureRace) {
                $featureStart = $this->toUtc($apiSession['startTime'] ?? null, (string) ($apiSession['gmtOffset'] ?? $offset));
            }
        }

        $race = F2Race::query()->updateOrCreate(
            ['f2_season_id' => $season->id, 'round' => $round],
            [
                'meeting_key' => $meetingKey,
                // Връзката към F1 пистата дава българското име на Гран при-то
                // (config/race-names-bg.php) и кръстосаните връзки към
                // страниците на пистите. Без нея постът казва „Hungary".
                'circuit_jolpica_id' => config('f2-circuit-map')[$location] ?? null,
                'location_name' => $location,
                'country_name' => (string) ($meeting['meetingCountryName'] ?? '') ?: null,
                'race_datetime_utc' => $featureStart,
                'slug' => Str::slug("{$season->year}-{$location}"),
            ],
        );

        $synced = 0;

        foreach ($apiSessions as $apiSession) {
            $type = F2SessionType::fromApiCode((string) ($apiSession['session'] ?? ''));

            if ($type === null) {
                continue;
            }

            $startsAt = $this->toUtc($apiSession['startTime'] ?? null, (string) ($apiSession['gmtOffset'] ?? $offset));
            $endsAt = $this->toUtc($apiSession['endTime'] ?? null, (string) ($apiSession['gmtOffset'] ?? $offset));
            $state = (string) ($apiSession['state'] ?? '');

            $sessionModel = F2RaceSession::query()->updateOrCreate(
                ['f2_race_id' => $race->id, 'session_type' => $type->value],
                [
                    'date' => $startsAt?->toDateString(),
                    'scheduled_at_utc' => $startsAt,
                    'ends_at_utc' => $endsAt,
                    'time_tbc' => $this->isPlaceholderTime($apiSession['startTime'] ?? null),
                    'state' => $state ?: null,
                ],
            );

            $this->stats['sessions']++;
            $synced++;

            if ($state === 'completed' && $this->needsResults($sessionModel, $type)) {
                $this->syncResults($season, $race, $sessionModel, $type);
            }
        }

        $this->propagatePole($race);

        return $synced;
    }

    /**
     * Пренася pole от квалификацията върху главното състезание.
     *
     * Прави се в края на кръга, а не при синхрона на квалификацията: сесиите
     * пристигат в ред p, q, r, тоест редът на състезанието още не съществува,
     * когато квалификацията се обработва.
     */
    private function propagatePole(F2Race $race): void
    {
        $qualifying = F2RaceSession::query()
            ->where('f2_race_id', $race->id)
            ->whereIn('session_type', [
                F2SessionType::Qualifying->value,
                F2SessionType::QualifyingGroupA->value,
            ])
            ->whereNotNull('pole_position_driver_id')
            ->first();

        if ($qualifying === null) {
            return;
        }

        F2RaceSession::query()
            ->where('f2_race_id', $race->id)
            ->where('session_type', F2SessionType::FeatureRace->value)
            ->update([
                'pole_position_driver_id' => $qualifying->pole_position_driver_id,
                'pole_position_time' => $qualifying->pole_position_time,
            ]);
    }

    /**
     * Пази ни от това да дърпаме класациите на целия сезон при всяко пускане.
     *
     * Състезанията се презареждат, докато класацията стане `Final` — стюардите
     * дописват наказания след финала. Тренировките и квалификациите нямат
     * `version` и веднъж свалени, повече не се пипат.
     */
    private function needsResults(F2RaceSession $sessionModel, F2SessionType $type): bool
    {
        if (! $sessionModel->results()->exists()) {
            return true;
        }

        return $type->isRace() && $sessionModel->version !== 'Final';
    }

    private function syncResults(F2Season $season, F2Race $race, F2RaceSession $sessionModel, F2SessionType $type): void
    {
        $meetingKey = (int) $race->meeting_key;
        $rows = match ($type) {
            F2SessionType::Practice => $this->client->practice($season->year, $meetingKey),
            F2SessionType::Qualifying => $this->client->qualifying($season->year, $meetingKey),
            F2SessionType::QualifyingGroupA => $this->client->qualifying($season->year, $meetingKey, 1),
            F2SessionType::QualifyingGroupB => $this->client->qualifying($season->year, $meetingKey, 2),
            F2SessionType::SprintRace => $this->client->race($season->year, $meetingKey, 1),
            F2SessionType::FeatureRace => $this->client->race($season->year, $meetingKey, 2),
        };

        if ($rows === []) {
            return;
        }

        $poleDriverId = null;
        $poleTime = null;

        foreach ($rows as $row) {
            $driver = $this->resolveDriver($season, $row);

            // Безименен ред — няма на кого да закачим резултата.
            if ($driver === null) {
                continue;
            }

            $position = $this->position($row);

            F2Result::query()->updateOrCreate(
                ['f2_race_session_id' => $sessionModel->id, 'f2_driver_id' => $driver->id],
                [
                    'position' => $position,
                    'laps_completed' => isset($row['lapsCompleted']) ? (int) $row['lapsCompleted'] : null,
                    'time_or_gap' => $this->timeOrGap($row, $type),
                    'points' => (float) ($row['racePoints'] ?? 0),
                    'status' => $this->status($row),
                    // Най-бърза обиколка НЕ се извежда от racePoints: API-то не
                    // различава общата най-бърза от точкуващата, а те се
                    // разминават (виж финалната класация на FIA). По-добре
                    // липсваща стойност, отколкото измислена.
                ],
            );

            $this->stats['results']++;

            if ($position === 1) {
                $poleDriverId = $driver->id;
                $poleTime = (string) ($row['classifiedTime'] ?? '') ?: null;
            }
        }

        $updates = ['version' => (string) ($rows[0]['version'] ?? '') ?: null];

        // Пол позицията живее върху квалификацията. Пренасянето ѝ върху
        // главното състезание става чак в края на кръга (propagatePole),
        // защото сесиите идват в ред p, q, r — при обработката на
        // квалификацията редът на състезанието още не съществува.
        if ($poleDriverId !== null && in_array($type, [
            F2SessionType::Qualifying,
            F2SessionType::QualifyingGroupA,
        ], strict: true)) {
            $updates['pole_position_driver_id'] = $poleDriverId;
            $updates['pole_position_time'] = $poleTime;
        }

        $sessionModel->update($updates);
    }

    /**
     * DNF пристига като `positionNumber: "666"` / `displayPosition: "NC"` —
     * часовиков сентинел, който не бива да изтича в базата.
     *
     * @param  array<string, mixed>  $row
     */
    private function position(array $row): ?int
    {
        $raw = (string) ($row['positionNumber'] ?? '');

        if ($raw === '' || $raw === '666') {
            return null;
        }

        $display = strtoupper((string) ($row['displayPosition'] ?? ''));

        if (in_array($display, ['NC', 'DQ', 'DSQ'], strict: true)) {
            return null;
        }

        return (int) $raw;
    }

    /**
     * @param  array<string, mixed>  $row
     */
    private function status(array $row): ?string
    {
        $code = (string) ($row['completionStatusCode'] ?? '');

        if ($code === '' || $code === 'OK') {
            return null;
        }

        return $code;
    }

    /**
     * Трите вида сесии носят времето в различни полета: тренировката и
     * квалификацията дават абсолютна обиколка, състезанието — време на
     * победителя и изоставане за останалите.
     *
     * @param  array<string, mixed>  $row
     */
    private function timeOrGap(array $row, F2SessionType $type): ?string
    {
        if (! $type->isRace()) {
            return (string) ($row['classifiedTime'] ?? '') ?: null;
        }

        $display = (string) ($row['displayTime'] ?? $row['raceTime'] ?? '');

        return $display !== '' ? $display : null;
    }

    /**
     * Пилотът зад един ред от API-то, или null когато редът няма самоличност.
     *
     * Идентичността е `driverReference` — той оцелява при преименуване, а
     * slug-ът не. Два записа на един и същ човек („Alex Dunne" от Wikipedia и
     * „Alexander Dunne" от API-то) се получаваха точно оттук: slug-овете се
     * разминават, старият ред няма reference, и съпоставянето не хващаше нищо.
     * Виж `f2:merge-duplicate-drivers` за сливането на вече създадените.
     *
     * @param  array<string, mixed>  $row
     */
    private function resolveDriver(F2Season $season, array $row): ?F2Driver
    {
        $reference = trim((string) ($row['driverReference'] ?? ''));
        $first = trim((string) ($row['driverFirstName'] ?? ''));
        $last = trim((string) ($row['driverLastName'] ?? ''));
        $slug = Str::slug(trim("{$first} {$last}")) ?: Str::slug($reference);

        // Ред без име И без reference не е пилот. Досега такъв ред създаваше
        // запис с празен slug — на прод един такъв събра три резултата и се
        // показваше като безименен ред в класацията. По-лошо: всеки следващ
        // безименен ред се съпоставяше с него по празния slug и трупаше чужди
        // резултати в същата купчина.
        if ($slug === '') {
            $this->stats['skipped_drivers']++;

            return null;
        }

        $team = $this->resolveTeam($season, $row);

        $driver = $this->matchDriver($season, $reference, $slug);

        $attributes = [
            'f2_team_id' => $team?->id,
            'first_name' => $first,
            'last_name' => $last,
            'driver_reference' => $reference ?: null,
            'tla' => (string) ($row['driverTLA'] ?? '') ?: null,
            'car_number' => isset($row['racingNumber']) ? (int) $row['racingNumber'] : null,
        ];

        $country = $this->countryCode($slug);

        if ($driver === null) {
            return F2Driver::query()->create([
                'f2_season_id' => $season->id,
                'slug' => $slug,
                'country_code' => $country,
                ...$attributes,
            ]);
        }

        // Преименуване: новият slug влиза само ако е свободен. (f2_season_id,
        // slug) е уникален — при зает slug записът щеше да гръмне и да спре
        // целия синхрон заради козметично поле.
        if ($driver->slug !== $slug && ! $this->slugTaken($season, $slug, $driver->id)) {
            $attributes['slug'] = $slug;
        }

        // Ред без reference го осиновява; ред с чужд reference не се пипа.
        if ($reference !== '' && filled($driver->driver_reference) && $driver->driver_reference !== $reference) {
            unset($attributes['driver_reference']);
        }

        // Само запълване, не презаписване: записите от Wikipedia и seed-а вече
        // носят верен флаг и са по-надежден източник от ръчната таблица.
        if ($country !== null && blank($driver->country_code)) {
            $attributes['country_code'] = $country;
        }

        $driver->update($attributes);

        return $driver;
    }

    /**
     * Съществуващият ред за този пилот: първо по reference, после по slug.
     *
     * Редът има значение. Съпоставяне „reference ИЛИ slug" в едно условие
     * може да върне чужд ред, чийто slug съвпада случайно, преди истинския по
     * reference.
     */
    private function matchDriver(F2Season $season, string $reference, string $slug): ?F2Driver
    {
        if ($reference !== '') {
            $byReference = F2Driver::query()
                ->where('f2_season_id', $season->id)
                ->where('driver_reference', $reference)
                ->first();

            if ($byReference !== null) {
                return $byReference;
            }
        }

        // Резервно по slug — така осиновяваме реда от Wikipedia, който няма
        // reference. Ред с ДРУГ reference е друг човек и не се пипа.
        return F2Driver::query()
            ->where('f2_season_id', $season->id)
            ->where('slug', $slug)
            ->where(fn ($query) => $query
                ->whereNull('driver_reference')
                ->when($reference !== '', fn ($q) => $q->orWhere('driver_reference', $reference)))
            ->first();
    }

    private function slugTaken(F2Season $season, string $slug, int $exceptId): bool
    {
        return F2Driver::query()
            ->where('f2_season_id', $season->id)
            ->where('slug', $slug)
            ->whereKeyNot($exceptId)
            ->exists();
    }

    /**
     * Националността липсва в API-то, затова идва от ръчна таблица по slug —
     * виж заглавния коментар на config/f2-driver-countries.php.
     */
    private function countryCode(string $slug): ?string
    {
        // Точкова нотация, а не индекс върху config('f2-driver-countries'):
        // при кеширан конфиг отпреди този файл индексът би върнал warning.
        $code = config("f2-driver-countries.{$slug}");

        return is_string($code) && $code !== '' ? $code : null;
    }

    /**
     * @param  array<string, mixed>  $row
     */
    private function resolveTeam(F2Season $season, array $row): ?F2Team
    {
        $name = (string) ($row['teamName'] ?? '');

        if ($name === '') {
            return null;
        }

        return F2Team::query()->updateOrCreate(
            ['f2_season_id' => $season->id, 'slug' => Str::slug($name)],
            [
                'name' => $name,
                'team_key' => (string) ($row['teamKey'] ?? '') ?: null,
                'color_hex' => $this->colour($row),
            ],
        );
    }

    /**
     * @param  array<string, mixed>  $row
     */
    private function colour(array $row): ?string
    {
        $colour = (string) ($row['teamColourCode'] ?? '');

        if ($colour === '') {
            return null;
        }

        return Str::startsWith($colour, '#') ? $colour : '#'.$colour;
    }

    /**
     * Класиранията идват готови от API-то, с включени бонуси за пол позиция —
     * затова тук няма смятане. Точките в `race` endpoint-а НЕ стават за целта:
     * те изключват бонуса за пол.
     */
    private function syncStandings(F2Season $season): void
    {
        try {
            $rows = $this->client->driverStandings($season->year);
        } catch (Throwable $e) {
            $this->stats['errors'][] = "класиране: {$e->getMessage()}";

            return;
        }

        foreach ($rows as $index => $row) {
            $reference = (string) ($row['driverReference'] ?? '');
            $slug = Str::slug(trim(((string) ($row['driverFirstName'] ?? '')).' '.((string) ($row['driverLastName'] ?? ''))));

            $query = F2Driver::query()->where('f2_season_id', $season->id);

            if ($reference !== '') {
                $query->where('driver_reference', $reference);
            } else {
                $query->where('slug', $slug);
            }

            // Полето е `position` — `positionNumber` е от резултатите на сесия
            // и в този endpoint го няма, тоест всяка позиция падаше към индекса.
            $position = is_numeric($row['position'] ?? null) ? (int) $row['position'] : 0;

            $query->update([
                // Позицията в отговора невинаги е попълнена; редът е
                // авторитетен и вече отчита изравняванията по правилата на FIA.
                'position' => $position > 0 ? $position : $index + 1,
                'points' => (float) ($row['championshipPoints'] ?? 0),
            ]);
        }
    }

    /**
     * Часът още не е обявен.
     *
     * Бъдещите кръгове идват с `startTime` точно в 00:00 местно време —
     * запълнител, не разписание. Проверено срещу API-то: и четирите сесии на
     * Монца (кръг 10) са в 00:00, тоест дори подредбата в рамките на деня е
     * произволна. F2 никога не кара в полунощ, така че проверката е безопасна.
     */
    private function isPlaceholderTime(mixed $startTime): bool
    {
        return is_string($startTime) && str_ends_with($startTime, 'T00:00:00');
    }

    private function toUtc(mixed $value, string $offset): ?Carbon
    {
        if (! is_string($value) || $value === '') {
            return null;
        }

        try {
            return Carbon::parse($value.$offset)->utc();
        } catch (Throwable) {
            return null;
        }
    }
}
