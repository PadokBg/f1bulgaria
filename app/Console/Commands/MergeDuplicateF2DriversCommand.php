<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\F2Driver;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use Illuminate\Console\Command;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Слива редовете, които описват един и същ пилот под различно изписване.
 *
 * Как се стига дотам: Wikipedia синхронът записа „Alex Dunne", официалното API
 * после върна „Alexander Dunne". Slug-овете се разминават, старият ред няма
 * `driver_reference`, и съпоставянето в F2ApiSync създаде втори ред. Резултат
 * на прод (20.09.2026): по два реда за Дън в 2025 и 2026 и по два за
 * Фитипалди — а /tsolov подрежда по `position` и показваше един и същ пилот
 * два пъти, изхвърляйки истинския пети.
 *
 * ПО ПОДРАЗБИРАНЕ САМО ОТЧИТА. Разпознаването е по нормализирано име, а не по
 * ключ от API-то — тоест е евристика и трябва човешко око, преди да пипне
 * данни. Сливането става с `--apply`.
 */
class MergeDuplicateF2DriversCommand extends Command
{
    protected $signature = 'f2:merge-duplicate-drivers
        {--season= : Само този сезон (година)}
        {--apply : Наистина слива; без него само отчита}';

    protected $description = 'Слива дублираните редове за един и същ пилот от F2 синхрона.';

    /**
     * Наставки, които едни източници пишат, а други не („Fittipaldi Jr." срещу
     * „Fittipaldi").
     */
    private const SUFFIXES = ['jr', 'jnr', 'junior', 'sr', 'snr', 'senior', 'ii', 'iii'];

    public function handle(): int
    {
        $seasons = $this->seasons();

        if ($seasons->isEmpty()) {
            $this->warn('Няма такъв сезон.');

            return self::FAILURE;
        }

        $merged = 0;
        $found = 0;

        foreach ($seasons as $season) {
            foreach ($this->duplicateGroups($season) as $group) {
                $found++;
                $merged += $this->handleGroup($season, $group) ? 1 : 0;
            }
        }

        $this->reportNameless();

        if ($found === 0) {
            $this->info('Няма дублирани пилоти.');

            return self::SUCCESS;
        }

        if (! $this->option('apply')) {
            $this->newLine();
            $this->warn("Намерени {$found} групи. Нищо НЕ е променено — пусни пак с --apply.");

            return self::SUCCESS;
        }

        $this->newLine();
        $this->info("Слети {$merged} от {$found} групи.");

        return self::SUCCESS;
    }

    /**
     * @return Collection<int, F2Season>
     */
    private function seasons(): Collection
    {
        $query = F2Season::query()->orderBy('year');

        if ($year = $this->option('season')) {
            $query->where('year', (int) $year);
        }

        return $query->get();
    }

    /**
     * Групите редове, които изглеждат като един и същ човек.
     *
     * @return Collection<int, Collection<int, F2Driver>>
     */
    private function duplicateGroups(F2Season $season): Collection
    {
        return F2Driver::query()
            ->where('f2_season_id', $season->id)
            ->where('last_name', '!=', '')
            ->get()
            ->groupBy(fn (F2Driver $driver): string => $this->identityKey($driver))
            ->filter(fn (Collection $group): bool => $group->count() > 1)
            ->values();
    }

    /**
     * Нормализирана самоличност: фамилия без пунктуация и наставки + първата
     * буква на името. „Alex Dunne" и „Alexander Dunne" дават едно и също;
     * „Fittipaldi Jr." и „Fittipaldi" — също.
     */
    private function identityKey(F2Driver $driver): string
    {
        $last = Str::of($driver->last_name)->lower()->ascii()->replaceMatches('/[^a-z\s]/', '')->trim();

        $parts = collect(explode(' ', (string) $last))
            ->filter(fn (string $part): bool => $part !== '' && ! in_array($part, self::SUFFIXES, true));

        $first = Str::of($driver->first_name)->lower()->ascii()->replaceMatches('/[^a-z]/', '')->substr(0, 1);

        return $parts->implode(' ').'|'.$first;
    }

    /**
     * @param  Collection<int, F2Driver>  $group
     */
    private function handleGroup(F2Season $season, Collection $group): bool
    {
        $references = $group->pluck('driver_reference')->filter()->unique();

        $this->line('');
        $this->line("<options=bold>Сезон {$season->year}</> — ".$group->first()->last_name);

        foreach ($group as $driver) {
            $this->line(sprintf(
                '  #%d  %-24s ref=%-10s поз=%-4s точки=%-6s резултати=%d',
                $driver->id,
                $driver->slug,
                $driver->driver_reference ?? '—',
                $driver->position ?? '—',
                $driver->points,
                $this->resultCount($driver),
            ));
        }

        // Два РАЗЛИЧНИ reference значат двама различни души (братя, съименници)
        // — тогава евристиката по име е сгрешила и не пипаме нищо.
        if ($references->count() > 1) {
            $this->warn('  ⚠ Различни driver_reference — приемаме ги за различни пилоти, пропускаме.');

            return false;
        }

        $keep = $this->canonical($group);
        $drop = $group->reject(fn (F2Driver $driver): bool => $driver->is($keep));

        $this->line("  → остава #{$keep->id} ({$keep->slug}), сливат се: ".$drop->pluck('id')->implode(', '));

        if (! $this->option('apply')) {
            return false;
        }

        $this->merge($keep, $drop);

        $this->info("  ✓ слято в #{$keep->id}");

        return true;
    }

    /**
     * Кой ред оцелява: този с reference (идва от официалното API), после с
     * най-много резултати, после с най-много точки. Резултатите тежат повече
     * от точките — точките се презаписват от следващия синхрон на класирането,
     * закачените резултати не.
     *
     * @param  Collection<int, F2Driver>  $group
     */
    private function canonical(Collection $group): F2Driver
    {
        return $group
            ->sort(fn (F2Driver $a, F2Driver $b): int => [
                (int) filled($b->driver_reference),
                $this->resultCount($b),
                (float) $b->points,
                -$a->id,
            ] <=> [
                (int) filled($a->driver_reference),
                $this->resultCount($a),
                (float) $a->points,
                -$b->id,
            ])
            ->first();
    }

    /**
     * @param  Collection<int, F2Driver>  $drop
     */
    private function merge(F2Driver $keep, Collection $drop): void
    {
        DB::transaction(function () use ($keep, $drop): void {
            foreach ($drop as $driver) {
                $this->moveResults($keep, $driver);

                // Тези два ключа са `nullOnDelete` — без пренасочване изтриването
                // тихо ги занулява и пол позицията на кръга изчезва.
                F2RaceSession::query()
                    ->where('pole_position_driver_id', $driver->id)
                    ->update(['pole_position_driver_id' => $keep->id]);

                F2RaceSession::query()
                    ->where('fastest_lap_driver_id', $driver->id)
                    ->update(['fastest_lap_driver_id' => $keep->id]);

                // Запълваме липсващото от изтривания ред, без да газим наличното.
                // array_filter с изрична проверка за null — голият array_filter
                // би изхвърлил и валидна нула (напр. номер 0 в тестови данни).
                $keep->fill(array_filter([
                    'driver_reference' => blank($keep->driver_reference) ? $driver->driver_reference : null,
                    'tla' => blank($keep->tla) ? $driver->tla : null,
                    'country_code' => blank($keep->country_code) ? $driver->country_code : null,
                    'car_number' => $keep->car_number === null ? $driver->car_number : null,
                ], fn ($value): bool => $value !== null));

                $driver->delete();
            }

            $keep->save();
        });
    }

    /**
     * Пренася резултатите на изтривания ред. `(f2_race_session_id,
     * f2_driver_id)` е уникален — ако и двата реда имат резултат за една сесия,
     * остава този на канонния, а дубликатът се изтрива.
     */
    private function moveResults(F2Driver $keep, F2Driver $driver): void
    {
        $taken = F2Result::query()
            ->where('f2_driver_id', $keep->id)
            ->pluck('f2_race_session_id')
            ->all();

        F2Result::query()
            ->where('f2_driver_id', $driver->id)
            ->whereIn('f2_race_session_id', $taken)
            ->delete();

        F2Result::query()
            ->where('f2_driver_id', $driver->id)
            ->update(['f2_driver_id' => $keep->id]);
    }

    private function resultCount(F2Driver $driver): int
    {
        return F2Result::query()->where('f2_driver_id', $driver->id)->count();
    }

    /**
     * Безименните редове НЕ се сливат автоматично: нямат самоличност, по която
     * да ги познаем, а резултатите им са закачени за някого. Само ги показваме
     * — изтриването им е решение на човек.
     */
    private function reportNameless(): void
    {
        $nameless = F2Driver::query()
            ->where(fn ($query) => $query->where('slug', '')->orWhere('last_name', ''))
            ->get();

        if ($nameless->isEmpty()) {
            return;
        }

        $this->newLine();
        $this->warn('Безименни редове (от ред на API-то без име и без reference):');

        foreach ($nameless as $driver) {
            $this->line("  #{$driver->id} сезон_id={$driver->f2_season_id} резултати=".$this->resultCount($driver));
        }

        $this->line('  Тези не се сливат автоматично — решѝ ръчно на кого са резултатите.');
    }
}
