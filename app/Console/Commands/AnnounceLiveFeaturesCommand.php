<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Console\Commands\Concerns\SendsBulkMail;
use App\Mail\LiveFeaturesAnnouncementMail;
use App\Models\NewsletterSend;
use App\Models\Season;
use App\Services\Newsletter\NewsletterAudience;
use App\Services\Predictions\PredictionLockService;
use App\Services\Races\RaceNameLocalizer;
use App\Services\Tsolov\TsolovMeter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\URL;

/**
 * Писмото за вълната „уикендът на живо" — пуска се РЪЧНО, няма график.
 *
 * Идемпотентно през newsletter_sends по MAIL_TYPE: повторен пуск (или
 * дублирана команда от два терминала) не праща втори път. При следваща вълна
 * новости се прави нова команда с нов slug — този не се преизползва.
 */
class AnnounceLiveFeaturesCommand extends Command
{
    use SendsBulkMail;

    protected $signature = 'padok:announce-live
        {--dry-run : Само отчита кой би получил писмо и какво ще пише вътре}
        {--force : Праща дори ако това съобщение вече е изпращано}';

    protected $description = 'Изпраща писмото за прогнозите на живо, Цоловметъра и класацията в играта.';

    /** Уникален slug на тази вълна — държи идемпотентността в newsletter_sends. */
    private const MAIL_TYPE = 'announcement-2026-09-live-predictions';

    /**
     * Разделите, към които писмото води. Изключен флаг = 404 на кликване, а
     * разпратено писмо не се връща обратно.
     */
    private const REQUIRED_FEATURES = [
        'live_predictions' => 'Прогнози на живо',
        'tsolov' => 'Цолов',
        'game' => 'Игра',
    ];

    public function handle(NewsletterAudience $audience, PredictionLockService $locks, TsolovMeter $tsolov): int
    {
        $off = collect(self::REQUIRED_FEATURES)
            ->reject(fn (string $label, string $flag): bool => (bool) config("features.{$flag}"));

        if ($off->isNotEmpty()) {
            $this->error('Изключени раздели: '.$off->implode(', ').'. Писмото щеше да води към 404 — не пращам.');

            return self::FAILURE;
        }

        if (! $this->option('force') && $this->alreadySent()) {
            $this->info('Това съобщение вече е изпращано — пропускаме. (--force за повторно)');

            return self::SUCCESS;
        }

        $recipients = $audience->users();
        $subscribers = $audience->subscribersWithoutAccount($recipients);

        $summary = $tsolov->summary();
        $nextRace = $this->nextRace($locks);
        // Обещаваме писмото след кръга само ако наистина ще тръгне.
        $resultMailOn = (bool) config('features.race_result_mail');

        if ($this->option('dry-run')) {
            $this->info("[dry-run] Биха получили писмо: {$recipients->count()} потребители + {$subscribers->count()} бюлетинни абонати.");
            $this->line('Цоловметър: '.($summary === null
                ? 'НЯМА — секцията ще се скрие'
                : "{$summary['position']}-и, {$summary['points']} т."));
            $this->line('Следващ кръг: '.($nextRace['name'] ?? 'няма отворен — CTA към класирането'));
            $this->line('Писмо след кръга: '.($resultMailOn ? 'обещава се' : 'НЕ се споменава (флагът е изключен)'));

            return self::SUCCESS;
        }

        // Маркираме ПРЕДИ пращането, както дайджестът: дублиран пуск вижда
        // записа и не праща втори път.
        NewsletterSend::create([
            'mail_type' => self::MAIL_TYPE,
            'sent_at' => now(),
        ]);

        foreach ($recipients as $user) {
            $this->sendMail($user, new LiveFeaturesAnnouncementMail(
                tsolov: $summary,
                nextRace: $nextRace,
                resultMailOn: $resultMailOn,
                userUnsubscribeUrl: URL::signedRoute('newsletter.user-unsubscribe', ['user' => $user->id]),
            ));
        }

        foreach ($subscribers as $subscriber) {
            $this->sendMail($subscriber->email, new LiveFeaturesAnnouncementMail(
                tsolov: $summary,
                nextRace: $nextRace,
                resultMailOn: $resultMailOn,
                unsubscribeToken: $subscriber->unsubscribe_token,
            ));
        }

        $this->info("Писмото е изпратено: {$recipients->count()} потребители + {$subscribers->count()} бюлетинни абонати.");

        $this->reportMailOutcome();

        return self::SUCCESS;
    }

    /**
     * Следващият кръг с още отворени прогнози — CTA-то на писмото. null при
     * липса (краесезонна пауза) → писмото сочи към класирането.
     *
     * @return array{name:string, url:string, deadline:?string}|null
     */
    private function nextRace(PredictionLockService $locks): ?array
    {
        $season = Season::current();

        if ($season === null) {
            return null;
        }

        $race = $season->races()
            ->whereNotNull('qualifying_datetime_utc')
            ->where('qualifying_datetime_utc', '>', now())
            ->orderBy('qualifying_datetime_utc')
            ->first();

        if ($race === null) {
            return null;
        }

        $deadline = $locks->lockDeadline($race);

        if ($deadline === null || $deadline->isPast()) {
            return null;
        }

        return [
            'name' => app(RaceNameLocalizer::class)->forRace($race),
            'url' => route('races.show', $race->id),
            'deadline' => $deadline->setTimezone('Europe/Sofia')->format('d.m.Y, H:i').' ч.',
        ];
    }

    private function alreadySent(): bool
    {
        return NewsletterSend::query()
            ->where('mail_type', self::MAIL_TYPE)
            ->exists();
    }
}
