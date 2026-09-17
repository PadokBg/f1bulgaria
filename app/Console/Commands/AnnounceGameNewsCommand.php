<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Console\Commands\Concerns\SendsBulkMail;
use App\Mail\GameNewsMail;
use App\Models\NewsletterSend;
use App\Services\Newsletter\NewsletterAudience;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\URL;

/**
 * „Какво е ново в играта" (септември 2026) — пуска се РЪЧНО, СЛЕД деплоя.
 *
 * Същият договор като padok:announce-game: всички регистрирани (без банати и
 * спрели имейлите) + бюлетинните абонати без акаунт, идемпотентно през
 * newsletter_sends по MAIL_TYPE, --dry-run само брои, --force повтаря нарочно.
 * Праща синхронно (SendsBulkMail) — при мъртъв worker опашката би „изпратила"
 * в нищото.
 */
class AnnounceGameNewsCommand extends Command
{
    use SendsBulkMail;

    protected $signature = 'padok:announce-game-news
        {--dry-run : Само отчита кой би получил писмо}
        {--force : Праща дори ако това съобщение вече е изпращано}';

    protected $description = 'Изпраща писмото „ново в играта: истинско състезание" до всички регистрирани и абонатите на бюлетина.';

    /**
     * Уникален slug на тази вълна — държи идемпотентността в newsletter_sends.
     */
    private const MAIL_TYPE = 'game-news-2026-09-race';

    public function handle(NewsletterAudience $audience): int
    {
        // Писмото води към /game. При изключен флаг рутът връща 404 — а
        // разпратено писмо не се връща обратно.
        if (! config('features.game')) {
            $this->error('Играта е изключена (FEATURE_GAME). Писмото щеше да води към 404 — не пращам.');

            return self::FAILURE;
        }

        // Писмото описва класацията „Състезание". Без таблицата ѝ кодът още не
        // е деплойнат и хората биха отворили играта без нито една от новостите.
        if (! Schema::hasTable('game_race_records')) {
            $this->error('Няма таблица game_race_records — новата версия не е деплойната. Първо deploy.sh, после писмото.');

            return self::FAILURE;
        }

        if (! $this->option('force') && $this->alreadySent()) {
            $this->info('Това съобщение вече е изпращано — пропускаме. (--force за повторно)');

            return self::SUCCESS;
        }

        $recipients = $audience->users();
        $subscribers = $audience->subscribersWithoutAccount($recipients);

        // Писмото кани „просто отговори" — без Reply-To отговорите отиват към
        // novini@padok.bg, който няма пощенска кутия (виж config/mail.php).
        if (blank(config('mail.reply_to.address'))) {
            $this->warn('MAIL_REPLY_TO_ADDRESS не е зададен — отговорите на писмото ще се загубят.');
        }

        if ($this->option('dry-run')) {
            $this->info("[dry-run] Биха получили писмо: {$recipients->count()} потребители + {$subscribers->count()} бюлетинни абонати.");

            return self::SUCCESS;
        }

        // Маркираме ПРЕДИ пращането, както дайджестът: дублиран пуск вижда
        // записа и не праща втори път.
        NewsletterSend::create([
            'mail_type' => self::MAIL_TYPE,
            'sent_at' => now(),
        ]);

        foreach ($recipients as $user) {
            $this->sendMail($user, new GameNewsMail(
                userUnsubscribeUrl: URL::signedRoute('newsletter.user-unsubscribe', ['user' => $user->id]),
            ));
        }

        foreach ($subscribers as $subscriber) {
            $this->sendMail($subscriber->email, new GameNewsMail(
                unsubscribeToken: $subscriber->unsubscribe_token,
            ));
        }

        $this->info("Писмото е изпратено: {$recipients->count()} потребители + {$subscribers->count()} бюлетинни абонати.");

        $this->reportMailOutcome();

        return self::SUCCESS;
    }

    private function alreadySent(): bool
    {
        return NewsletterSend::query()
            ->where('mail_type', self::MAIL_TYPE)
            ->exists();
    }
}
