<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Models\McpToolCall;
use Closure;
use Illuminate\Http\Request;
use Laravel\Sanctum\PersonalAccessToken;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

/**
 * Одит лог на MCP инструментите: всяко `tools/call` през сървъра се записва в
 * mcp_tool_calls с потребител, токен, инструмент, аргументи, статус и време.
 * Останалите JSON-RPC методи (initialize, tools/list, ping) са шум и се
 * пропускат.
 *
 * Логът е след изпълнението, за да носи статуса, но е в `finally` — извикване,
 * което гръмне с изключение, също остава в одита. Записът не бива да събаря
 * самия инструмент (read-only сървър; при бъдещ write сървър това решение се
 * преразглежда — там неуспешен одит трябва да блокира действието).
 *
 * Употреба в рут: LogMcpToolCalls::using('ops-read').
 */
class LogMcpToolCalls
{
    /** Аргумент, по-дълъг от толкова знака, се реже в лога (SQL, текст). */
    private const MAX_ARGUMENT_LENGTH = 2000;

    /** Колкото побира колоната mcp_tool_calls.error. */
    private const MAX_ERROR_LENGTH = 500;

    public static function using(string $server): string
    {
        return static::class.':'.$server;
    }

    public function handle(Request $request, Closure $next, string $server): Response
    {
        $calls = $this->toolCalls($request);

        if ($calls === []) {
            return $next($request);
        }

        $startedAt = hrtime(true);
        $status = 500;
        $outcomes = [];

        try {
            $response = $next($request);
            $status = $response->getStatusCode();
            $outcomes = $this->outcomes($response, count($calls));

            return $response;
        } finally {
            $durationMs = (int) ((hrtime(true) - $startedAt) / 1_000_000);

            foreach ($calls as $index => $call) {
                $outcome = $outcomes[$index] ?? ['is_error' => $status >= 400, 'error' => null];

                $this->store($request, $server, $call, $status, $outcome, $durationMs);
            }
        }
    }

    /**
     * Резултатът на ниво инструмент. Отказ от инструмента (Response::error,
     * невалидни аргументи, SQL грешка) е HTTP 200 с `result.isError = true`
     * — по HTTP статус отхвърлен DELETE и успешен SELECT са еднакви. Стрийм
     * (SSE) отговорите не се четат — там остава само статусът.
     *
     * @return array<int, array{is_error: bool, error: string|null}>
     */
    private function outcomes(Response $response, int $expected): array
    {
        if ($response instanceof StreamedResponse) {
            return [];
        }

        $body = json_decode((string) $response->getContent(), true);

        if (! is_array($body)) {
            return [];
        }

        $replies = array_is_list($body) ? $body : [$body];
        $outcomes = [];

        foreach (array_slice($replies, 0, $expected) as $reply) {
            if (! is_array($reply)) {
                continue;
            }

            if (is_array($reply['error'] ?? null)) {
                $outcomes[] = ['is_error' => true, 'error' => $this->clip($reply['error']['message'] ?? 'JSON-RPC error')];

                continue;
            }

            $isError = (bool) ($reply['result']['isError'] ?? false);
            $text = $isError ? ($reply['result']['content'][0]['text'] ?? null) : null;

            $outcomes[] = ['is_error' => $isError, 'error' => $this->clip($text)];
        }

        return $outcomes;
    }

    private function clip(mixed $text): ?string
    {
        if (! is_string($text) || $text === '') {
            return null;
        }

        return mb_strlen($text) > self::MAX_ERROR_LENGTH
            ? mb_substr($text, 0, self::MAX_ERROR_LENGTH - 1).'…'
            : $text;
    }

    /**
     * Извиканите инструменти от тялото на заявката — един обект или (по стар
     * протокол) масив от обекти.
     *
     * @return list<array{tool: string, arguments: array<string, mixed>}>
     */
    private function toolCalls(Request $request): array
    {
        $body = $request->json()->all();

        if ($body === []) {
            return [];
        }

        $messages = array_is_list($body) ? $body : [$body];
        $calls = [];

        foreach ($messages as $message) {
            if (! is_array($message) || ($message['method'] ?? null) !== 'tools/call') {
                continue;
            }

            $tool = $message['params']['name'] ?? null;

            if (! is_string($tool) || $tool === '') {
                continue;
            }

            $arguments = $message['params']['arguments'] ?? [];

            $calls[] = [
                'tool' => $tool,
                'arguments' => is_array($arguments) ? $this->truncate($arguments) : [],
            ];
        }

        return $calls;
    }

    /**
     * @param  array<string, mixed>  $arguments
     * @return array<string, mixed>
     */
    private function truncate(array $arguments): array
    {
        return array_map(
            fn (mixed $value): mixed => is_string($value) && mb_strlen($value) > self::MAX_ARGUMENT_LENGTH
                ? mb_substr($value, 0, self::MAX_ARGUMENT_LENGTH).'…'
                : $value,
            $arguments,
        );
    }

    /**
     * @param  array{tool: string, arguments: array<string, mixed>}  $call
     * @param  array{is_error: bool, error: string|null}  $outcome
     */
    private function store(Request $request, string $server, array $call, int $status, array $outcome, int $durationMs): void
    {
        try {
            $user = $request->user();
            $token = $user?->currentAccessToken();

            McpToolCall::create([
                'user_id' => $user?->getAuthIdentifier(),
                'token_name' => $token instanceof PersonalAccessToken ? $token->name : null,
                'server' => $server,
                'tool' => $call['tool'],
                'arguments' => $call['arguments'],
                'status' => $status,
                'is_error' => $outcome['is_error'],
                'error' => $outcome['error'],
                'duration_ms' => $durationMs,
                'ip_address' => $request->ip(),
            ]);
        } catch (Throwable $e) {
            report($e);
        }
    }
}
