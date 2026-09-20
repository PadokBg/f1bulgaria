<?php

declare(strict_types=1);

namespace App\Mail;

use App\Mail\Concerns\HasUnsubscribeHeaders;
use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Carbon;

/**
 * Писмото за вълната „уикендът на живо": точкуване на прогнозите по време на
 * състезанието, Цоловметърът и класацията в Хронометъра.
 *
 * Пуска се ръчно с `padok:announce-live` — няма график, защото няма
 * редовност. Числата за Цолов идват от базата в момента на пращането: писмо
 * със застояла разлика в шампионата е по-лошо от писмо без числа.
 */
class LiveFeaturesAnnouncementMail extends Mailable
{
    use HasUnsubscribeHeaders, Queueable, SerializesModels;

    /**
     * @param  array<string, mixed>|null  $tsolov  Цоловметърът (null скрива секцията)
     * @param  array{name:string, url:string, deadline:?string}|null  $nextRace  следващият кръг с отворени прогнози
     * @param  bool  $resultMailOn  да се обещае ли писмото след кръга — само ако флагът е вдигнат
     * @param  string|null  $unsubscribeToken  токен за отписване (само за бюлетинни абонати)
     * @param  string|null  $userUnsubscribeUrl  signed линк за спиране на имейлите (само за потребители с акаунт)
     */
    public function __construct(
        public ?array $tsolov = null,
        public ?array $nextRace = null,
        public bool $resultMailOn = false,
        public ?string $unsubscribeToken = null,
        public ?string $userUnsubscribeUrl = null,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            subject: 'Падок — прогнозите вече се точкуват на живо',
        );
    }

    public function content(): Content
    {
        return new Content(
            markdown: 'mail.live-features-announcement',
            with: ['tsolovNext' => $this->tsolovNext()],
        );
    }

    /**
     * „спринт на 24 септември." — следващото каране на Цолов, с готова
     * пунктуация (шаблонът само го отпечатва).
     *
     * Датата, а не мястото: `location_name` идва от API-то на латиница
     * („Baku") и в българско изречение се чете като грешка.
     *
     * И датата, а не часът: разписанието на Ф2 в базата носи запълнители —
     * за Баку 2026 тренировката и квалификацията стоят на един и същи час.
     * Грешен час в разпратено писмо не се поправя.
     */
    private function tsolovNext(): ?string
    {
        $next = $this->tsolov['next'] ?? null;

        if (! is_array($next) || ! is_string($next['at'] ?? null)) {
            return null;
        }

        $label = mb_strtolower((string) ($next['label'] ?? 'каране'));
        $date = Carbon::parse($next['at'])->timezone('Europe/Sofia')->locale('bg')->translatedFormat('j F');

        return "{$label} на {$date}.";
    }
}
