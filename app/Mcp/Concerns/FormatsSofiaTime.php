<?php

declare(strict_types=1);

namespace App\Mcp\Concerns;

use Carbon\CarbonImmutable;
use Carbon\CarbonInterface;
use DateTimeInterface;

/**
 * Базата пази UTC; всичко, което инструментите връщат на човек (и на AI
 * клиента, който говори с човек), е в софийско време с изричен суфикс.
 */
trait FormatsSofiaTime
{
    protected function sofia(DateTimeInterface|string|null $utc, string $format = 'Y-m-d H:i'): ?string
    {
        if ($utc === null) {
            return null;
        }

        $moment = $utc instanceof CarbonInterface ? $utc : CarbonImmutable::parse($utc);

        return $moment->timezone('Europe/Sofia')->format($format).' Sofia';
    }
}
