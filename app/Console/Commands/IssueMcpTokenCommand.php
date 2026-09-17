<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Enums\McpAbility;
use App\Models\User;
use Illuminate\Console\Command;

/**
 * Издава Sanctum токен за оперативния MCP сървър (/mcp/ops) на админ акаунт.
 *
 * Няма UI за това нарочно: токенът е ключ към продукцията и се издава от
 * сървъра, от човек с shell. Показва се веднъж (в базата стои само SHA-256
 * хешът); повторно издаване със същото име отменя стария — това е и
 * ротацията. Само действащ админ (is_admin, без бан) получава токен, а
 * портата го проверява пак при всяка заявка.
 */
class IssueMcpTokenCommand extends Command
{
    protected $signature = 'padok:mcp-token
        {email? : Имейл на админа; по подразбиране ADMIN_EMAIL от .env}
        {--name=claude-code : Име на токена (за кой клиент е); същото име = ротация}
        {--days=90 : Валидност в дни; 0 = без изтичане}
        {--revoke : Отменя всички MCP токени на потребителя, без да издава нов}';

    protected $description = 'Издава (или отменя) токен за read-only MCP сървъра /mcp/ops на админ акаунт.';

    public function handle(): int
    {
        $email = mb_strtolower(trim((string) ($this->argument('email') ?? config('app.admin_email', ''))));

        if ($email === '') {
            $this->error('Подай имейл или задай ADMIN_EMAIL в .env (и презареди config кеша).');

            return self::FAILURE;
        }

        $user = User::query()->where('email', $email)->first();

        if ($user === null) {
            $this->error("Няма потребител с имейл {$email}.");

            return self::FAILURE;
        }

        if (! $user->isActiveAdmin()) {
            $this->error("{$email} не е действащ админ (is_admin + без бан) — MCP токен не се издава.");

            return self::FAILURE;
        }

        $ability = McpAbility::OpsRead;

        if ($this->option('revoke')) {
            $revoked = $user->tokens()->where('abilities', 'like', "%{$ability->value}%")->delete();
            $this->info("Отменени MCP токени за {$email}: {$revoked}.");

            return self::SUCCESS;
        }

        $name = trim((string) $this->option('name'));
        $rawDays = (string) $this->option('days');

        if ($name === '') {
            $this->error('Името на токена не може да е празно.');

            return self::FAILURE;
        }

        // Само цифри: `(int) 'thirty'` би дало 0 = „без изтичане“ — постоянен
        // токен към прод заради правописна грешка.
        if (! ctype_digit($rawDays)) {
            $this->error('--days трябва да е цяло число ≥ 0 (0 = без изтичане).');

            return self::FAILURE;
        }

        $days = (int) $rawDays;
        $rotated = $user->tokens()->where('name', $name)->delete();
        $expiresAt = $days > 0 ? now()->addDays($days) : null;

        $token = $user->createToken($name, [$ability->value], $expiresAt);

        if ($rotated > 0) {
            $this->warn("Старият токен „{$name}“ е отменен — клиентът трябва да се преконфигурира с новия.");
        }

        $this->info("Токен „{$name}“ за {$email} ({$ability->label()}), "
            .($expiresAt === null ? 'без изтичане' : 'валиден до '.$expiresAt->timezone('Europe/Sofia')->format('d.m.Y H:i').' Sofia')
            .'. Показва се само сега:');
        $this->newLine();
        $this->line($token->plainTextToken);
        $this->newLine();
        // Токенът нарочно НЕ е вътре в готова shell команда — така влиза в
        // историята на терминала и я надживява. Подава се през променлива.
        $this->line('Claude Code (токенът през променлива, не в самата команда):');
        $this->line('  read -s PADOK_MCP_TOKEN   # постави токена, Enter (PowerShell: $env:PADOK_MCP_TOKEN = Read-Host)');
        $this->line('  claude mcp add --transport http padok-ops '.url('/mcp/ops').' --header "Authorization: Bearer $PADOK_MCP_TOKEN"');
        $this->newLine();
        $this->line('Рутът работи само с FEATURE_MCP_OPS=true (после config:cache).');

        return self::SUCCESS;
    }
}
