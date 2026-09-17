<?php

declare(strict_types=1);

namespace App\Services\Game;

use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

/**
 * Пуска Node валидатор (scripts/game/validate-*.mjs) с payload файл и връща
 * JSON изхода му. Инфраструктурен провал (няма node, счупен скрипт, гърмящ
 * изход) дава null — викащият го отбелязва като 'error', не като измама.
 */
class NodeReplayRunner
{
    /**
     * @param  string  $script  Път спрямо корена на проекта
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>|null
     */
    public function run(string $script, array $payload, int $recordId): ?array
    {
        $payloadPath = tempnam(sys_get_temp_dir(), 'padok-replay-');

        try {
            file_put_contents($payloadPath, json_encode($payload, JSON_THROW_ON_ERROR));

            $process = new Process([
                (string) config('game.validator.node', 'node'),
                base_path($script),
                $payloadPath,
            ], base_path(), timeout: 90);

            $process->run();

            if (! $process->isSuccessful()) {
                Log::warning('game: валидаторът не тръгна', [
                    'script' => $script,
                    'record' => $recordId,
                    'exit' => $process->getExitCode(),
                    'stderr' => mb_substr($process->getErrorOutput(), 0, 500),
                ]);

                return null;
            }

            $result = json_decode(trim($process->getOutput()), true, 512, JSON_THROW_ON_ERROR);

            return is_array($result) ? $result : null;
        } catch (\Throwable $e) {
            Log::warning('game: валидацията гръмна', [
                'script' => $script,
                'record' => $recordId,
                'error' => $e->getMessage(),
            ]);

            return null;
        } finally {
            @unlink($payloadPath);
        }
    }
}
