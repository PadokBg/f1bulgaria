<?php

declare(strict_types=1);

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Database\Factories\UserFactory;
use Filament\Models\Contracts\FilamentUser;
use Filament\Panel;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable implements FilamentUser
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable;

    /**
     * @var list<string>
     */
    protected $fillable = [
        'name',
        'email',
        'google_id',
        'password',
        'favorite_driver_id',
        'favorite_constructor_id',
        'bio',
        'avatar_path',
        'is_admin',
        'banned_at',
    ];

    /**
     * @var list<string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_admin' => 'boolean',
            'banned_at' => 'datetime',
            'email_opt_out_at' => 'datetime',
        ];
    }

    public function canAccessPanel(Panel $panel): bool
    {
        return $this->isActiveAdmin();
    }

    /**
     * Админ с действащи права: флагът е вдигнат И акаунтът не е блокиран.
     * Единственото място за това правило — панелът, MCP достъпът и издаването
     * на токени го четат оттук, за да не се разминат.
     */
    public function isActiveAdmin(): bool
    {
        return $this->is_admin && $this->banned_at === null;
    }

    public function isBanned(): bool
    {
        return $this->banned_at !== null;
    }

    /** @return BelongsTo<Driver, $this> */
    public function favoriteDriver(): BelongsTo
    {
        return $this->belongsTo(Driver::class, 'favorite_driver_id');
    }

    /** @return BelongsTo<Constructor, $this> */
    public function favoriteConstructor(): BelongsTo
    {
        return $this->belongsTo(Constructor::class, 'favorite_constructor_id');
    }

    /** @return HasMany<Prediction, $this> */
    public function predictions(): HasMany
    {
        return $this->hasMany(Prediction::class);
    }

    /** @return HasMany<GameLapRecord, $this> */
    public function gameLapRecords(): HasMany
    {
        return $this->hasMany(GameLapRecord::class);
    }

    /** @return HasMany<GameSession, $this> */
    public function gameSessions(): HasMany
    {
        return $this->hasMany(GameSession::class);
    }

    /** @return HasMany<GameFeedback, $this> */
    public function gameFeedback(): HasMany
    {
        return $this->hasMany(GameFeedback::class);
    }

    /** @return BelongsToMany<Badge, $this> */
    public function badges(): BelongsToMany
    {
        return $this->belongsToMany(Badge::class)
            ->withPivot('awarded_at', 'seen_at')
            ->withTimestamps();
    }

    /** @return HasMany<SurveyResponse, $this> */
    public function surveyResponses(): HasMany
    {
        return $this->hasMany(SurveyResponse::class);
    }

    /** @return HasMany<QuizAttempt, $this> */
    public function quizAttempts(): HasMany
    {
        return $this->hasMany(QuizAttempt::class);
    }

    /**
     * Всички въпроси, на които потребителят е отговарял — вярно или грешно.
     * Правилото е един опит на въпрос на седмица; pivot-ът пази кога.
     *
     * @return BelongsToMany<QuizQuestion, $this>
     */
    public function answeredQuizQuestions(): BelongsToMany
    {
        return $this->belongsToMany(QuizQuestion::class, 'quiz_question_user')
            ->withPivot('answered_at', 'first_correct_at')
            ->withTimestamps();
    }

    /**
     * Подмножеството с верен отговор — точките в куиза се броят оттук.
     *
     * @return BelongsToMany<QuizQuestion, $this>
     */
    public function masteredQuizQuestions(): BelongsToMany
    {
        return $this->answeredQuizQuestions()
            ->wherePivotNotNull('first_correct_at');
    }
}
