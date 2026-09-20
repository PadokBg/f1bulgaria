<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Питането „какво би постигнало това време" — за гост, който още не е влязъл.
 *
 * Публично и НЕ пише нищо: отговорът е само позиция и изоставане спрямо
 * класацията. Затова тук няма трейс и няма анти-чийт — подправено време
 * показва подвеждаща позиция на самия подправящ и нищо повече. Истинските
 * проверки са в StoreGameLapRequest, през който минава и запазената обиколка
 * след вход.
 */
class PreviewGameLapRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $tracks = array_keys((array) config('game.tracks', []));

        return [
            'track' => ['required', 'string', Rule::in($tracks)],
            // Същите граници като при записа — извън тях няма смислена позиция.
            'lap_ms' => ['required', 'integer', 'min:10000', 'max:1200000'],
        ];
    }
}
