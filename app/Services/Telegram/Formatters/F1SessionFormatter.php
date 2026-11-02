<?php

declare(strict_types=1);

namespace App\Services\Telegram\Formatters;

use App\Enums\ChannelPostKind;
use App\Models\Race;
use App\Services\Races\RaceClassificationProvider;
use App\Services\Telegram\TelegramText;
use App\Support\DriverName;
use App\Support\Ordinal;

/**
 * Съставя поста за сесия от Формула 1.
 *
 * Откъде идва класацията решава RaceClassificationProvider — тук само се
 * рисува. Затова постът за състезание излиза минути след финала с временната
 * класация от OpenF1 и се РЕДАКТИРА на място, когато Jolpica донесе
 * официалната с точките.
 */
class F1SessionFormatter
{
    private const VISIBLE_POSITIONS = 10;

    private const MEDALS = [1 => '🥇', 2 => '🥈', 3 => '🥉'];

    public function __construct(
        private readonly RaceClassificationProvider $classifications,
    ) {}

    public function format(Race $race, ChannelPostKind $kind): string
    {
        $type = $kind->sessionType();
        $section = $type !== null ? $this->classifications->for($race, $type) : null;

        if ($section === null) {
            return '';
        }

        $lines = [
            '🏁 <b>Формула 1 · '.TelegramText::escape($kind->label()).'</b>',
            TelegramText::escape($this->subtitle($race)),
            '',
        ];

        foreach (array_slice($section['rows'], 0, self::VISIBLE_POSITIONS) as $row) {
            $lines[] = $this->line($row);
        }

        $highlight = $this->highlightLine($section['rows']);

        if ($highlight !== null) {
            $lines[] = '';
            $lines[] = $highlight;
        }

        $retired = collect($section['rows'])
            ->filter(fn (array $row): bool => (bool) $row['dnf'])
            ->map(fn (array $row): string => (string) $row['driver'])
            ->filter();

        if ($retired->isNotEmpty()) {
            $lines[] = '';
            $lines[] = '<i>Отпаднали: '.TelegramText::escape($retired->implode(', ')).'</i>';
        }

        if ($kind === ChannelPostKind::F1Race && $race->poleDriver !== null) {
            $lines[] = '';
            $lines[] = '🅿️ От пол позиция: <b>'.TelegramText::escape(
                DriverName::display($race->poleDriver->slug, $race->poleDriver->fullName()),
            ).'</b>';
        }

        if ($section['provisional']) {
            $lines[] = '';
            $lines[] = '<i>⚠️ Временна класация — точките още не са официални. Постът ще се обнови.</i>';
        }

        $lines[] = '';
        $lines[] = '<a href="'.TelegramText::escape(route('races.show', $race)).'">Пълна класация в Падок</a>';

        // CC BY-NC-SA изисква посочване на източника. Временната класация на
        // състезание също идва от OpenF1, затова проверяваме и нея.
        if ($kind->requiresOpenF1Attribution() || $section['provisional']) {
            $lines[] = '<i>'.TelegramText::escape((string) config('channel.openf1_attribution')).'</i>';
        }

        return implode("\n", $lines);
    }

    private function subtitle(Race $race): string
    {
        return collect([
            $this->classifications->raceName($race),
            $race->round !== null ? "кръг {$race->round}" : null,
        ])->filter()->implode(' · ');
    }

    /**
     * Българинът, ако е извън първите десет — както в постовете за Формула 2.
     *
     * Редакционно, не техническо (config/channel.php, highlight_driver_slugs):
     * аудиторията отваря поста заради Цолов. 12-и във FP1 в Мексико 2026, той
     * изпадаше от поста, точно когато беше новината.
     *
     * @param  array<int, array<string, mixed>>  $rows
     */
    private function highlightLine(array $rows): ?string
    {
        /** @var array<int, string> $slugs */
        $slugs = (array) config('channel.highlight_driver_slugs', []);

        if ($slugs === []) {
            return null;
        }

        $row = collect($rows)
            ->skip(self::VISIBLE_POSITIONS)
            ->first(fn (array $row): bool => $row['position'] !== null
                && in_array($row['name_slug'] ?? null, $slugs, strict: true));

        if ($row === null) {
            return null;
        }

        return '🇧🇬 <b>'.TelegramText::escape((string) $row['driver']).'</b> — '.Ordinal::bg((int) $row['position']);
    }

    /**
     * @param  array<string, mixed>  $row
     */
    private function line(array $row): string
    {
        $position = (int) $row['position'];
        $prefix = self::MEDALS[$position] ?? str_pad((string) $position, 2, ' ', STR_PAD_LEFT).'.';

        $parts = [$prefix.' <b>'.TelegramText::escape((string) $row['driver']).'</b>'];

        if (filled($row['team'])) {
            $parts[] = TelegramText::escape((string) $row['team']);
        }

        if (filled($row['time'])) {
            $parts[] = TelegramText::escape((string) $row['time']);
        }

        // Изоставането има смисъл само след лидера.
        if ($position > 1 && filled($row['gap'])) {
            $parts[] = TelegramText::escape((string) $row['gap']);
        }

        if ((float) ($row['points'] ?? 0) > 0) {
            $points = rtrim(rtrim(number_format((float) $row['points'], 1, ',', ''), '0'), ',');
            $parts[] = TelegramText::escape("{$points} т.");
        }

        $line = implode(' · ', $parts);

        return $row['fastest_lap'] ? $line.' 🟣' : $line;
    }
}
