<?php

declare(strict_types=1);

namespace App\Services\Ops;

use Carbon\CarbonImmutable;

/**
 * Опашката на логовете за MCP инструмента recent-logs.
 *
 * Чете файла ОТЗАД на парчета — scheduler.log на прод расте с месеци и
 * никога не се върти, така че `file()` върху него би изяло паметта на
 * php-fpm. Знае и кой е „днешният“ Laravel лог: локално `single`
 * (laravel.log), на прод `daily` (laravel-YYYY-MM-DD.log).
 */
class LogTail
{
    /** Толкова байта наведнъж от края на файла. */
    private const CHUNK_BYTES = 65_536;

    /** Начало на Laravel запис: "[2026-09-17 10:00:00] production.ERROR: ..." */
    private const ENTRY_START = '/^\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[^\]]*\] \w+\.(\w+):/';

    /** Над толкова реда един запис (stack trace) се реже, за да не удави отговора. */
    private const MAX_LINES_PER_ENTRY = 40;

    /**
     * Файлът за даден източник или null, ако такъв още няма.
     *
     * Laravel логът се търси първо по конфигурирания канал, после като
     * най-новия laravel*.log — .env на прод е бил редактиран на ръка и
     * догадка по конфига без резервен вариант би върнала „няма лог“ при
     * пълна папка.
     */
    public function resolvePath(string $source): ?string
    {
        $directory = storage_path('logs');

        $candidates = match ($source) {
            'scheduler' => [$directory.DIRECTORY_SEPARATOR.'scheduler.log'],
            'ssr' => [$directory.DIRECTORY_SEPARATOR.'ssr.log'],
            default => $this->laravelLogCandidates($directory),
        };

        foreach ($candidates as $candidate) {
            if (is_file($candidate)) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * Последните $lines реда на файла, в естествен ред.
     *
     * @return list<string>
     */
    public function lines(string $path, int $lines): array
    {
        $handle = fopen($path, 'rb');

        if ($handle === false) {
            return [];
        }

        try {
            $size = filesize($path) ?: 0;
            $position = $size;
            $buffer = '';

            while ($position > 0 && substr_count($buffer, "\n") <= $lines) {
                $read = min(self::CHUNK_BYTES, $position);
                $position -= $read;
                fseek($handle, $position);
                $buffer = fread($handle, $read).$buffer;
            }
        } finally {
            fclose($handle);
        }

        if ($buffer === '') {
            return [];
        }

        $all = preg_split('/\r?\n/', rtrim($buffer, "\r\n")) ?: [];

        // Първото парче почти винаги започва по средата на ред — режем до
        // поисканите редове от края, за да не върнем и половин ред отгоре.
        return array_values(array_slice($all, -$lines));
    }

    /**
     * Групира редове в записи на Laravel лога и по избор филтрира по ниво.
     * Ред, който не започва запис (stack trace, продължение), върви със
     * записа над него. Редове преди първия разпознат запис се пазят като
     * „опашка“ на отрязан запис.
     *
     * @param  list<string>  $lines
     * @return list<string> всеки елемент е цял (възможно многоредов) запис
     */
    public function entries(array $lines, ?string $level = null): array
    {
        $entries = [];
        $current = [];
        $currentLevel = null;

        $flush = function () use (&$entries, &$current, &$currentLevel, $level): void {
            if ($current === []) {
                return;
            }

            if ($level === null || $currentLevel === null || strcasecmp($currentLevel, $level) === 0) {
                $entries[] = $this->clip($current);
            }

            $current = [];
            $currentLevel = null;
        };

        foreach ($lines as $line) {
            if (preg_match(self::ENTRY_START, $line, $matches) === 1) {
                $flush();
                $currentLevel = $matches[1];
            }

            $current[] = $line;
        }

        $flush();

        return $entries;
    }

    /**
     * @param  list<string>  $lines
     */
    private function clip(array $lines): string
    {
        if (count($lines) <= self::MAX_LINES_PER_ENTRY) {
            return implode("\n", $lines);
        }

        $hidden = count($lines) - self::MAX_LINES_PER_ENTRY;

        return implode("\n", array_slice($lines, 0, self::MAX_LINES_PER_ENTRY))
            ."\n… (още {$hidden} реда)";
    }

    /**
     * @return list<string>
     */
    private function laravelLogCandidates(string $directory): array
    {
        $candidates = [];

        foreach ($this->activeChannels() as $channel) {
            $driver = (string) config("logging.channels.{$channel}.driver", '');
            $path = (string) config("logging.channels.{$channel}.path", '');

            if ($path === '') {
                continue;
            }

            $candidates[] = match ($driver) {
                'daily' => $this->dailyPath($path),
                default => $path,
            };
        }

        $newest = collect(glob($directory.DIRECTORY_SEPARATOR.'laravel*.log') ?: [])
            ->sortByDesc(fn (string $file): int => (int) filemtime($file))
            ->first();

        if (is_string($newest)) {
            $candidates[] = $newest;
        }

        return array_values(array_unique($candidates));
    }

    /**
     * Каналът по подразбиране, разгънат през stack-а до реалните драйвери.
     *
     * @return list<string>
     */
    private function activeChannels(): array
    {
        $default = (string) config('logging.default', 'stack');

        if ((string) config("logging.channels.{$default}.driver", '') !== 'stack') {
            return [$default];
        }

        $members = config("logging.channels.{$default}.channels", []);

        return array_values(array_filter(
            is_array($members) ? $members : [],
            fn (mixed $channel): bool => is_string($channel) && $channel !== '',
        ));
    }

    private function dailyPath(string $path): string
    {
        $info = pathinfo($path);
        $date = CarbonImmutable::now()->format('Y-m-d');

        return $info['dirname'].DIRECTORY_SEPARATOR.$info['filename']."-{$date}.".($info['extension'] ?? 'log');
    }
}
