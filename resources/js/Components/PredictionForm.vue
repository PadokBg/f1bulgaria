<script setup>
import InputError from '@/Components/InputError.vue';
import { useForm } from '@inertiajs/vue3';
import { computed } from 'vue';

const props = defineProps({
    raceId: Number,
    drivers: Array,
    prediction: Object,
    locked: Boolean,
});

// Бонус полетата тръгват празни, а не с 0/false: неподаден отговор трябва да
// се различава от „прогнозирам нула отпаднали".
const form = useForm({
    p1_driver_id: props.prediction?.p1_driver_id ?? null,
    p2_driver_id: props.prediction?.p2_driver_id ?? null,
    p3_driver_id: props.prediction?.p3_driver_id ?? null,
    pole_driver_id: props.prediction?.pole_driver_id ?? null,
    fastest_lap_driver_id: props.prediction?.fastest_lap_driver_id ?? null,
    dnf_count: props.prediction?.dnf_count ?? null,
    safety_car: props.prediction?.safety_car ?? null,
});

const podiumFields = [
    { key: 'p1_driver_id', emoji: '🥇', label: 'Победител (P1)' },
    { key: 'p2_driver_id', emoji: '🥈', label: 'Втори (P2)' },
    { key: 'p3_driver_id', emoji: '🥉', label: 'Трети (P3)' },
];

const bonusDriverFields = [
    { key: 'pole_driver_id', emoji: '⏱️', label: 'Pole позиция' },
    { key: 'fastest_lap_driver_id', emoji: '🔥', label: 'Най-бърза обиколка' },
];

// Подиумът е достатъчен, за да се играе — бутонът не бива да чака бонусите.
const podiumComplete = computed(() =>
    Boolean(form.p1_driver_id && form.p2_driver_id && form.p3_driver_id),
);

// text-base на телефон: под 16px Safari зумва при фокус и изхвърля
// потребителя от контекста. От sm: нагоре се връщаме на компактния размер.
const fieldClass = 'mt-1 block w-full rounded-lg border-zinc-800 bg-zinc-950 text-base text-white placeholder-zinc-500 transition focus:border-red-600 focus:ring-1 focus:ring-red-600 disabled:opacity-50 sm:text-sm';

const submit = () => {
    form.post(route('predictions.store', props.raceId), {
        preserveScroll: true,
    });
};
</script>

<template>
    <form class="space-y-6" @submit.prevent="submit">
        <fieldset class="space-y-4">
            <legend class="mb-3 text-sm font-bold uppercase tracking-wider text-white">
                Подиум<span class="ml-2 font-medium normal-case tracking-normal text-zinc-500">— това стига, за да играеш</span>
            </legend>

            <div v-for="field in podiumFields" :key="field.key">
                <label :for="field.key" class="text-sm font-medium text-zinc-400"><span aria-hidden="true">{{ field.emoji }}</span> {{ field.label }}</label>
                <select :id="field.key" v-model="form[field.key]" :disabled="locked" :class="fieldClass">
                    <option :value="null">— избери пилот —</option>
                    <option v-for="driver in drivers" :key="driver.id" :value="driver.id">
                        {{ driver.name }}
                    </option>
                </select>
                <InputError class="mt-1" :message="form.errors[field.key]" />
            </div>
        </fieldset>

        <fieldset class="space-y-4 border-t border-zinc-800 pt-5">
            <legend class="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-400">
                Бонус<span class="ml-2 font-medium normal-case tracking-normal text-zinc-500">— по избор, за повече точки</span>
            </legend>

            <div v-for="field in bonusDriverFields" :key="field.key">
                <label :for="field.key" class="text-sm font-medium text-zinc-400"><span aria-hidden="true">{{ field.emoji }}</span> {{ field.label }}</label>
                <select :id="field.key" v-model="form[field.key]" :disabled="locked" :class="fieldClass">
                    <option :value="null">— пропусни —</option>
                    <option v-for="driver in drivers" :key="driver.id" :value="driver.id">
                        {{ driver.name }}
                    </option>
                </select>
                <InputError class="mt-1" :message="form.errors[field.key]" />
            </div>

            <div>
                <label for="dnf_count" class="text-sm font-medium text-zinc-400">💥 Брой отпаднали (DNF)</label>
                <input
                    id="dnf_count"
                    v-model.number="form.dnf_count"
                    type="number"
                    min="0"
                    max="20"
                    placeholder="пропусни"
                    :disabled="locked"
                    :class="fieldClass"
                />
                <InputError class="mt-1" :message="form.errors.dnf_count" />
            </div>

            <div>
                <!-- Тристепенно, не чекбокс: чекбоксът не може да изрази „не съм
                     отговорил", а само „не" — и празната форма щеше да носи точки. -->
                <label for="safety_car" class="text-sm font-medium text-zinc-400">🚨 Ще има ли safety car?</label>
                <select id="safety_car" v-model="form.safety_car" :disabled="locked" :class="fieldClass">
                    <option :value="null">— пропусни —</option>
                    <option :value="true">Да</option>
                    <option :value="false">Не</option>
                </select>
                <!-- Правилото живее в config/predictions.php (safety_car.count_virtual). -->
                <p class="mt-1 text-xs text-zinc-500">Брои се само истинският safety car — виртуалният (VSC) не.</p>
                <InputError class="mt-1" :message="form.errors.safety_car" />
            </div>
        </fieldset>

        <InputError :message="form.errors.prediction" />

        <button
            type="submit"
            :disabled="locked || form.processing || !podiumComplete"
            class="w-full rounded-lg bg-red-600 px-5 py-2.5 font-semibold text-white transition duration-200 hover:bg-red-500 disabled:opacity-50"
        >
            {{ prediction ? 'Обнови прогнозата' : 'Запази прогнозата' }}
        </button>
    </form>
</template>
