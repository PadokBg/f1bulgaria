<?php

declare(strict_types=1);

namespace App\Mail;

use App\Mail\Concerns\HasUnsubscribeHeaders;
use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/**
 * Какво е ново в играта (края на септември 2026): физическият модел на
 * двигателя от 2026 г., режимът за изпреварване вместо DRS, съперниците със
 * собствен двигател и играта при заключено завъртане на телефона. Пуска се
 * ръчно с padok:announce-game-engine, СЛЕД деплоя (описва живи неща).
 */
class GameEngineUpdateMail extends Mailable
{
    use HasUnsubscribeHeaders, Queueable, SerializesModels;

    /**
     * @param  string|null  $unsubscribeToken  токен за отписване (само за бюлетинни абонати)
     * @param  string|null  $userUnsubscribeUrl  signed линк за спиране на имейлите (само за потребители с акаунт)
     */
    public function __construct(
        public ?string $unsubscribeToken = null,
        public ?string $userUnsubscribeUrl = null,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            subject: 'Ново в играта на Падок: двигател като през 2026 и режим за изпреварване 🏁',
        );
    }

    public function content(): Content
    {
        return new Content(
            markdown: 'mail.game-engine-update',
        );
    }
}
