<?php

declare(strict_types=1);

use App\Enums\McpAbility;
use App\Models\User;
use Carbon\CarbonImmutable;
use Laravel\Sanctum\PersonalAccessToken;

beforeEach(function () {
    $this->travelTo(CarbonImmutable::parse('2026-09-17 12:00:00', 'Europe/Sofia'));
});

it('издава токен с ability за четене и срок на действащ админ', function () {
    $admin = User::factory()->create(['is_admin' => true, 'email' => 'admin@padok.bg']);

    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg', '--days' => 30])
        ->expectsOutputToContain('claude mcp add --transport http padok-ops')
        ->assertSuccessful();

    $token = PersonalAccessToken::query()->sole();

    expect($token->tokenable_id)->toBe($admin->id)
        ->and($token->name)->toBe('claude-code')
        ->and($token->abilities)->toBe([McpAbility::OpsRead->value])
        ->and($token->expires_at?->toDateTimeString())->toBe(now()->addDays(30)->toDateTimeString());
});

it('ползва ADMIN_EMAIL, когато няма подаден имейл, и --days=0 значи без изтичане', function () {
    config(['app.admin_email' => 'Admin@Padok.bg']);
    User::factory()->create(['is_admin' => true, 'email' => 'admin@padok.bg']);

    $this->artisan('padok:mcp-token', ['--days' => 0])->assertSuccessful();

    expect(PersonalAccessToken::query()->sole()->expires_at)->toBeNull();
});

it('ротира токен със същото име', function () {
    User::factory()->create(['is_admin' => true, 'email' => 'admin@padok.bg']);

    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg'])->assertSuccessful();
    $first = PersonalAccessToken::query()->sole();

    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg'])
        ->expectsOutputToContain('Старият токен „claude-code“ е отменен')
        ->assertSuccessful();

    $second = PersonalAccessToken::query()->sole();

    expect($second->id)->not->toBe($first->id);
});

it('отменя всички MCP токени с --revoke', function () {
    $admin = User::factory()->create(['is_admin' => true, 'email' => 'admin@padok.bg']);
    $admin->createToken('claude-code', [McpAbility::OpsRead->value]);
    $admin->createToken('claude-ai', [McpAbility::OpsRead->value]);
    $admin->createToken('drug', ['nyama:vrazka']);

    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg', '--revoke' => true])
        ->expectsOutputToContain('Отменени MCP токени за admin@padok.bg: 2.')
        ->assertSuccessful();

    expect($admin->tokens()->pluck('name')->all())->toBe(['drug']);
});

it('отказва на обикновен потребител, на блокиран админ и на непознат имейл', function () {
    User::factory()->create(['is_admin' => false, 'email' => 'fen@padok.bg']);
    User::factory()->create(['is_admin' => true, 'banned_at' => now(), 'email' => 'banned@padok.bg']);

    $this->artisan('padok:mcp-token', ['email' => 'fen@padok.bg'])->assertFailed();
    $this->artisan('padok:mcp-token', ['email' => 'banned@padok.bg'])->assertFailed();
    $this->artisan('padok:mcp-token', ['email' => 'nyama@padok.bg'])->assertFailed();

    expect(PersonalAccessToken::count())->toBe(0);
});

it('отказва нечислов --days вместо тихо да издаде вечен токен', function () {
    User::factory()->create(['is_admin' => true, 'email' => 'admin@padok.bg']);

    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg', '--days' => 'thirty'])->assertFailed();
    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg', '--days' => '-5'])->assertFailed();
    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg', '--days' => ''])->assertFailed();

    expect(PersonalAccessToken::count())->toBe(0);
});

it('не вписва токена в готова shell команда', function () {
    User::factory()->create(['is_admin' => true, 'email' => 'admin@padok.bg']);

    $this->artisan('padok:mcp-token', ['email' => 'admin@padok.bg'])
        ->expectsOutputToContain('Authorization: Bearer $PADOK_MCP_TOKEN')
        ->assertSuccessful();

    $token = PersonalAccessToken::query()->sole();

    expect($token->name)->toBe('claude-code');
});

it('отказва без имейл и без ADMIN_EMAIL', function () {
    config(['app.admin_email' => '']);

    $this->artisan('padok:mcp-token')->assertFailed();
});
