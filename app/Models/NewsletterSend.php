<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Журнал на изпратените бюлетинни имейли — източник на истината „пращано ли
 * е вече“. Дайджестът и подсещането за прогноза маркират състезанието
 * (race_id), пулсът — само момента.
 */
class NewsletterSend extends Model
{
    public const TYPE_DIGEST = 'digest';

    public const TYPE_PULSE = 'pulse';

    public const TYPE_PREDICTION_REMINDER = 'prediction_reminder';

    public const TYPE_LIVE_COVERAGE = 'live_coverage';

    /** Резултатът след кръга — до подалите прогноза за него. */
    public const TYPE_RACE_RESULT = 'race_result';

    /**
     * Оперативни аларми за news pipeline-а (news:health-check). Не са
     * бюлетин и не стигат до абонати — журналът се ползва само за да се
     * помни дали в момента тече инцидент.
     *
     * Живеят тук, а не в кеша: `deploy.sh` вика `optimize:clear`, което
     * включва `cache:clear`, и при cache store `database` изтрива маркера.
     * Деплой по време на авария иначе алармира втори път и губи завинаги
     * писмото за възстановяване.
     */
    public const TYPE_PIPELINE_ALERT = 'pipeline_alert';

    public const TYPE_PIPELINE_RECOVERED = 'pipeline_recovered';

    protected $fillable = ['mail_type', 'race_id', 'sent_at'];

    protected function casts(): array
    {
        return ['sent_at' => 'datetime'];
    }

    /** @return BelongsTo<Race, $this> */
    public function race(): BelongsTo
    {
        return $this->belongsTo(Race::class);
    }
}
