<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Mcp\Concerns\FormatsSofiaTime;
use App\Services\Ops\LogTail;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\JsonSchema\Types\Type;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Опашката на логовете без SSH. Laravel логът се групира по записи (stack
 * trace върви с грешката си) и може да се филтрира по ниво; scheduler.log и
 * ssr.log са суров текст.
 */
#[Name('recent-logs')]
#[Description('Последните редове от лог файл на сървъра: laravel (днешният Laravel лог, групиран по записи, филтър по ниво), scheduler (изходът на фоновите крон команди) или ssr (Inertia SSR демонът).')]
#[IsReadOnly]
#[IsIdempotent]
class RecentLogsTool extends Tool
{
    use FormatsSofiaTime;

    private const SOURCES = ['laravel', 'scheduler', 'ssr'];

    private const LEVELS = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

    private const DEFAULT_LINES = 100;

    public function handle(Request $request, LogTail $tail): ResponseFactory|Response
    {
        $maxLines = max(1, (int) config('ops.mcp.log_max_lines', 500));

        $validated = $request->validate([
            'source' => ['nullable', 'string', 'in:'.implode(',', self::SOURCES)],
            'lines' => ['nullable', 'integer', 'min:1', "max:{$maxLines}"],
            'level' => ['nullable', 'string', 'in:'.implode(',', self::LEVELS)],
        ], [
            'source.*' => 'source е едно от: '.implode(', ', self::SOURCES).'.',
            'lines.*' => "lines е цяло число от 1 до {$maxLines}.",
            'level.*' => 'level е едно от: '.implode(', ', self::LEVELS).'.',
        ]);

        $source = (string) ($validated['source'] ?? 'laravel');
        $lines = (int) ($validated['lines'] ?? self::DEFAULT_LINES);
        $level = isset($validated['level']) ? (string) $validated['level'] : null;

        $path = $tail->resolvePath($source);

        if ($path === null) {
            return Response::error("Няма лог файл за „{$source}“ в storage/logs — нищо не е писано там (или пътят в конфига е друг).");
        }

        $raw = $tail->lines($path, $lines);
        $isLaravel = $source === 'laravel';
        $entries = $isLaravel ? $tail->entries($raw, $level) : $raw;

        return Response::structured([
            'source' => $source,
            'file' => basename($path),
            'size_bytes' => filesize($path) ?: 0,
            'modified_at' => $this->sofia(date('c', filemtime($path) ?: 0)),
            'lines_read' => count($raw),
            'level' => $isLaravel ? $level : null,
            'note' => $isLaravel
                ? 'Записите са групирани (stack trace върви със своя запис); дълги записи са отрязани.'
                : 'Суров текст — филтърът по ниво не важи за този източник.',
            'entries' => $entries,
        ]);
    }

    /**
     * @return array<string, Type>
     */
    public function schema(JsonSchema $schema): array
    {
        return [
            'source' => $schema->string()
                ->enum(self::SOURCES)
                ->default('laravel')
                ->description('Кой лог: laravel (приложението), scheduler (крон командите), ssr (Inertia SSR).'),

            'lines' => $schema->integer()
                ->min(1)
                ->max(max(1, (int) config('ops.mcp.log_max_lines', 500)))
                ->default(self::DEFAULT_LINES)
                ->description('Колко реда от края на файла да прочете, преди филтриране.'),

            'level' => $schema->string()
                ->enum(self::LEVELS)
                ->description('Само записи с това ниво (важи за source=laravel).'),
        ];
    }
}
