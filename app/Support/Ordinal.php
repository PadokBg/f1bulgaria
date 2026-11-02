<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Поредно числително с цифри, както се пише на български: 1-ви, 2-ри, 3-ти,
 * 7-ми, 12-и, 21-ви.
 *
 * Наставката е краят на думата („двадесет и първи" → 21-ви), затова зависи
 * от последната цифра — освен при 11–19, където думата е „…надесети". С 22
 * коли на старта „21-и" и „22-и" щяха да са грешни.
 */
class Ordinal
{
    public static function bg(int $number): string
    {
        $lastTwo = $number % 100;
        $last = $number % 10;

        $suffix = match (true) {
            $lastTwo >= 11 && $lastTwo <= 19 => 'и',
            $last === 1 => 'ви',
            $last === 2 => 'ри',
            $last === 3, $last === 4 => 'ти',
            $last === 7, $last === 8 => 'ми',
            default => 'и',
        };

        return "{$number}-{$suffix}";
    }
}
