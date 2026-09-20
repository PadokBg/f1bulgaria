<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Models\Season;
use App\Models\User;
use Illuminate\Auth\Events\Registered;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rules\Password;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

class RegisteredUserController extends Controller
{
    /**
     * Display the registration view.
     */
    public function create(): Response
    {
        return Inertia::render('Auth/Register');
    }

    /**
     * Handle an incoming registration request.
     *
     * @throws ValidationException
     */
    public function store(Request $request): RedirectResponse
    {
        $request->validate([
            'name' => 'required|string|max:255',
            'email' => 'required|string|lowercase|email|max:255|unique:'.User::class,
            'password' => ['required', 'confirmed', Password::defaults()],
        ]);

        $user = User::create([
            'name' => $request->name,
            'email' => $request->email,
            'password' => Hash::make($request->password),
        ]);

        event(new Registered($user));

        Auth::login($user);

        // intended() пази случая „дойдох от нещо конкретно" — гостът, който
        // е направил обиколка в играта и се е регистрирал, за да я запази,
        // трябва да се върне при нея, а не при прогнозите. Без intended в
        // сесията поведението е непроменено.
        return redirect()->intended($this->landingUrl());
    }

    /**
     * Къде отива новорегистрираният, когато не е дошъл от конкретна страница.
     *
     * Не към `dashboard` (той е публичният календар и не иска нищо от човека),
     * а към следващия кръг с отворени прогнози — формата е точно там и това е
     * действието, заради което е дошъл. Ако няма отворен кръг, класирането
     * поне показва играта.
     */
    private function landingUrl(): string
    {
        $season = Season::current();

        if ($season !== null) {
            $race = $season->races()
                ->whereNotNull('qualifying_datetime_utc')
                ->where('qualifying_datetime_utc', '>', now())
                ->orderBy('qualifying_datetime_utc')
                ->first();

            if ($race !== null) {
                return route('races.show', $race->id, absolute: false);
            }
        }

        return route('leaderboard', absolute: false);
    }
}
